import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid } from '@chorus/core'
import { createIndexer, type Indexer } from '../../src/index-run.js'

/**
 * BRAIN-2 AC3, AC4 — the framework fixtures, indexed for real.
 *
 * The unit tests in `src/routes.test.ts` check each strategy against synthetic
 * file lists. This checks the same five against **directories on disk**, walked
 * by the real walker and written to a real database — which is where the
 * differences that only appear in a real repository show up: a lockfile that
 * has to be found, non-page files that must not become routes, and a route
 * resolving to a `code_files` row rather than to a string.
 *
 * A route map that is *nearly* right is worse than none: it sends someone
 * confidently to the wrong file.
 */
describe('BRAIN-2 framework fixtures', () => {
  let db: IsolatedDatabase
  let indexer: Indexer
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

  const embed = async (texts: readonly string[]): Promise<number[][]> =>
    texts.map(() => new Array<number>(1536).fill(0.1))

  async function linked(): Promise<{ workspaceId: string; repositoryId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    const [repository] = await db.admin.query<{ id: string }>(
      `SELECT id FROM repositories WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    await db.admin.execute(`DELETE FROM route_map WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM code_chunks WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM code_symbols WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM code_imports WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM code_files WHERE workspace_id = $1`, [workspaceId])
    return { workspaceId, repositoryId: repository!.id }
  }

  /** Indexes one fixture and returns its stored route map. */
  async function indexFixture(name: string) {
    const { workspaceId, repositoryId } = await linked()
    const run = await indexer.index({
      workspaceId,
      repositoryId,
      workingCopy: join(FIXTURES, name),
      commitSha: `commit-${name}`,
    })

    const routes = await db.admin.query<{ route_pattern: string; component_path: string; component_file_id: string | null }>(
      `SELECT route_pattern, component_path, component_file_id
         FROM route_map WHERE workspace_id = $1 ORDER BY route_pattern`,
      [workspaceId],
    )
    const [repository] = await db.admin.query<{ settings: Record<string, unknown> }>(
      `SELECT settings FROM repositories WHERE id = $1`,
      [repositoryId],
    )
    return { run, routes, settings: repository!.settings, workspaceId }
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    indexer = await createIndexer(db.config, { embed, embeddingModel: 'fake-embed-v1' })
  }, 180_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('BRAIN-2 AC3: Next.js App Router routes resolve to their page components', async () => {
    const { run, routes } = await indexFixture('nextjs-app')

    expect(run.detected.framework).toBe('nextjs-app')
    expect(routes.map((route) => [route.route_pattern, route.component_path])).toEqual([
      ['/', 'app/page.tsx'],
      // The route group does not appear in the URL; including it would produce
      // a route that 404s.
      ['/blog/:slug', 'app/blog/[slug]/page.tsx'],
      ['/pricing', 'app/(marketing)/pricing/page.tsx'],
      ['/settings', 'app/settings/page.tsx'],
    ])

    // Every route reaches an indexed file, not just a path string. A route
    // pointing at a file that was never indexed is a dead end that looks like
    // an answer.
    for (const route of routes) {
      expect(route.component_file_id, `${route.route_pattern} must reach a code_files row`).not.toBeNull()
    }
  })

  it('BRAIN-2 AC3: a layout is not a route', async () => {
    const { routes } = await indexFixture('nextjs-app')
    expect(routes.map((route) => route.component_path)).not.toContain('app/layout.tsx')
  })

  it('BRAIN-2 AC3: Next.js Pages Router, including API routes but not _app', async () => {
    const { run, routes } = await indexFixture('nextjs-pages')

    expect(run.detected.framework).toBe('nextjs-pages')
    expect(routes.map((route) => [route.route_pattern, route.component_path])).toEqual([
      ['/', 'pages/index.tsx'],
      ['/about', 'pages/about.tsx'],
      ['/api/health', 'pages/api/health.ts'],
      ['/blog/:slug', 'pages/blog/[slug].tsx'],
    ])
    expect(routes.map((route) => route.component_path)).not.toContain('pages/_app.tsx')
  })

  it('BRAIN-2 AC3: SvelteKit maps +page files and ignores its server siblings', async () => {
    const { run, routes } = await indexFixture('sveltekit')

    expect(run.detected.framework).toBe('sveltekit')
    expect(routes.map((route) => [route.route_pattern, route.component_path])).toEqual([
      ['/', 'src/routes/+page.svelte'],
      ['/about', 'src/routes/about/+page.svelte'],
      ['/blog/:slug', 'src/routes/blog/[slug]/+page.svelte'],
    ])
  })

  it('BRAIN-2 AC3: Nuxt maps its pages directory', async () => {
    const { run, routes } = await indexFixture('nuxt')

    expect(run.detected.framework).toBe('nuxt')
    expect(routes.map((route) => [route.route_pattern, route.component_path])).toEqual([
      ['/', 'pages/index.vue'],
      ['/about', 'pages/about.vue'],
      ['/blog/:slug', 'pages/blog/[slug].vue'],
    ])
  })

  it('BRAIN-2 AC3: React Router — configuration-based routing, read from source', async () => {
    const { run, routes } = await indexFixture('react-router')

    expect(run.detected.framework).toBe('react-router')
    expect(routes.map((route) => route.route_pattern)).toEqual(['/', '/settings', '/users/:id'])
    // The declaring file, which is what this strategy can honestly resolve.
    for (const route of routes) {
      expect(route.component_path).toBe('src/router.tsx')
      expect(route.component_file_id).not.toBeNull()
    }
  })

  it('BRAIN-2 AC4: conventions from a real fixture reach the repository settings', async () => {
    const { settings } = await indexFixture('nextjs-app')

    // What the brief builder (CODE-2) will read. A wrong command here is worse
    // than a missing one: the agent runs it and the failure looks like its own.
    expect(settings.conventions).toMatchObject({
      packageManager: 'pnpm',
      testCommand: 'pnpm run test',
      lintCommand: 'pnpm run lint',
      buildCommand: 'pnpm run build',
      contributionGuide: 'CONTRIBUTING.md',
      agentInstructions: ['AGENTS.md'],
    })
    expect(settings.designSystem).toMatchObject({ kind: 'local', path: 'src/components/ui' })
    expect(settings.previewProvider).toBe('vercel')
    expect(settings.framework).toBe('nextjs-app')
  })

  it('BRAIN-2 AC4: each fixture reports the package manager its lockfile implies', async () => {
    for (const [fixture, manager] of [
      ['nextjs-pages', 'npm'],
      ['nuxt', 'yarn'],
      ['sveltekit', 'pnpm'],
    ] as const) {
      const { settings } = await indexFixture(fixture)
      expect((settings.conventions as { packageManager: string }).packageManager, fixture).toBe(
        manager,
      )
    }
  })

  it('BRAIN-2 AC4: preview providers are detected per fixture', async () => {
    for (const [fixture, provider] of [
      ['nextjs-app', 'vercel'],
      ['nextjs-pages', 'netlify'],
      ['react-router', 'cloudflare'],
    ] as const) {
      const { settings } = await indexFixture(fixture)
      expect(settings.previewProvider, fixture).toBe(provider)
    }
  })

  it('BRAIN-2 AC3: a re-index replaces the route map rather than accumulating', async () => {
    const { workspaceId, repositoryId } = await linked()
    const workingCopy = join(FIXTURES, 'nextjs-app')

    await indexer.index({ workspaceId, repositoryId, workingCopy, commitSha: 'commit-1' })
    await indexer.index({ workspaceId, repositoryId, workingCopy, commitSha: 'commit-2' })

    const routes = await db.admin.query<{ route_pattern: string }>(
      `SELECT route_pattern FROM route_map WHERE workspace_id = $1`,
      [workspaceId],
    )
    // A merged map keeps routes whose files are gone, pointing at code that no
    // longer renders them — worse than an absent route, because it looks right.
    expect(routes).toHaveLength(4)
  })

  it('BRAIN-2 AC3: the route map survives an incremental re-index that changes nothing', async () => {
    // The trap: detection runs over the whole walk, not the changed files. A
    // route map derived from a diff would lose every route whose file did not
    // happen to change, which is nearly all of them.
    const { workspaceId, repositoryId } = await linked()
    const workingCopy = join(FIXTURES, 'sveltekit')

    await indexer.index({ workspaceId, repositoryId, workingCopy, commitSha: 'commit-1' })
    const second = await indexer.index({
      workspaceId,
      repositoryId,
      workingCopy,
      commitSha: 'commit-2',
    })

    expect(second.stats.filesIndexed).toBe(0)
    expect(second.stats.routesMapped).toBe(3)
  })
})
