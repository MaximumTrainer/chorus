import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createIndexer } from '@chorus/indexer'
import { createQueue, redisConfigFromEnv, type Queue } from '@chorus/queue'
import { ulid } from '@chorus/core'
import { createWorker, type RunningWorker } from '../../src/worker.js'
import { checkout } from '../../src/checkout.js'
import { INDEX_REPOSITORY_QUEUE } from '../../src/consumers/index-repository.js'

/**
 * BRAIN-2, INT-2 AC3, NFR-6 — indexing driven by the queue.
 *
 * The seam Phase 0's exit criteria need: enqueue on one side, a real BullMQ
 * broker in the middle, a real `git clone` and a real index on the other. A
 * fake queue would prove the consumer's logic and none of the things that
 * actually break — redelivery, retry, a working copy left behind.
 *
 * The remote is a local bare repository rather than a network host. That is a
 * genuine git clone over a genuine transport, with no account and no network,
 * which is the whole point: a test that needed GitHub is a test nobody else can
 * run.
 */
describe('BRAIN-2 queue-driven indexing', () => {
  let db: IsolatedDatabase
  let queue: Queue
  let worker: RunningWorker
  let bareRepo: string
  let firstCommit: string
  let secondCommit: string
  const prefix = `worker-${ulid()}`

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  /** A real repository with two commits, served over file:// . */
  function buildRemote(): void {
    const source = mkdtempSync(join(tmpdir(), 'chorus-source-'))
    const write = (path: string, text: string): void => {
      const full = join(source, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, text, 'utf8')
    }

    git(source, 'init', '--quiet', '--initial-branch', 'main')
    git(source, 'config', 'user.email', 'fixture@example.test')
    git(source, 'config', 'user.name', 'Fixture')

    write('package.json', JSON.stringify({ name: 'widgets', dependencies: { next: '^14' } }))
    write('pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
    write('app/page.tsx', 'export default function Home() { return null }\n')
    write('src/widget.ts', 'export function makeWidget(id: string) { return { id } }\n')
    write('.gitignore', '.env\n')
    write('.env', 'SECRET=hunter2\n')
    git(source, 'add', '--all')
    git(source, 'commit', '--quiet', '-m', 'first')
    firstCommit = git(source, 'rev-parse', 'HEAD')

    write('src/widget.ts', 'export function makeWidget(id: string) { return { id, v: 2 } }\n')
    write('app/settings/page.tsx', 'export default function Settings() { return null }\n')
    git(source, 'add', '--all')
    git(source, 'commit', '--quiet', '-m', 'second')
    secondCommit = git(source, 'rev-parse', 'HEAD')

    bareRepo = mkdtempSync(join(tmpdir(), 'chorus-bare-'))
    execFileSync('git', ['clone', '--quiet', '--bare', source, bareRepo])
    rmSync(source, { recursive: true, force: true })
  }

  async function linked(): Promise<{ workspaceId: string; repositoryId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    const [repository] = await db.admin.query<{ id: string }>(
      `SELECT id FROM repositories WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    // `repo_index_runs` included: seedWorkspace plants one so the tenancy suite
    // has a row to try to read across the boundary, and this suite counts runs.
    for (const table of [
      'route_map',
      'code_chunks',
      'code_symbols',
      'code_imports',
      'code_files',
      'repo_index_runs',
    ]) {
      await db.admin.execute(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId])
    }
    return { workspaceId, repositoryId: repository!.id }
  }

  const filesIn = (workspaceId: string) =>
    db.admin.query<{ path: string; commit_sha: string }>(
      `SELECT path, commit_sha FROM code_files WHERE workspace_id = $1 ORDER BY path`,
      [workspaceId],
    )

  beforeAll(async () => {
    buildRemote()
    db = await createIsolatedDatabase()
    queue = createQueue({ ...redisConfigFromEnv(), prefix })

    const indexer = await createIndexer(db.config, {
      embed: async (texts) => texts.map(() => new Array<number>(1536).fill(0.1)),
      embeddingModel: 'fake-embed-v1',
    })

    worker = await createWorker({
      queue,
      dbConfig: db.config,
      indexer,
      // Stands in for the git connector's scoped-token minting (INT-2 AC2).
      access: { cloneUrlFor: async () => ({ remote: bareRepo }) },
    })
  }, 180_000)

  afterAll(async () => {
    await worker?.stop()
    await db?.drop()
    rmSync(bareRepo, { recursive: true, force: true })
  })

  it('BRAIN-2: an enqueued job checks the commit out and indexes it', async () => {
    const { workspaceId, repositoryId } = await linked()

    await queue.enqueue(INDEX_REPOSITORY_QUEUE, {
      workspaceId,
      repositoryId,
      commitSha: firstCommit,
    })
    await queue.drain(INDEX_REPOSITORY_QUEUE)

    const files = await filesIn(workspaceId)
    // A set: the order rows come back in is the database's collation, which is
    // not what this test is about.
    expect(new Set(files.map((file) => file.path))).toEqual(
      new Set(['.gitignore', 'app/page.tsx', 'package.json', 'pnpm-lock.yaml', 'src/widget.ts']),
    )
    // The index says which commit it represents, which is what makes a citation
    // checkable rather than merely plausible.
    expect(files[0]!.commit_sha).toBe(firstCommit)

    // AC5 holds through the real path too, not only when a test hands the
    // indexer a directory: git tracked `.env`, and the ignore rules kept it out.
    const everything = JSON.stringify(
      await db.admin.query(`SELECT * FROM code_chunks WHERE workspace_id = $1`, [workspaceId]),
    )
    expect(everything).not.toContain('hunter2')
  })

  it('INT-2 AC3: a later commit re-indexes only what changed', async () => {
    const { workspaceId, repositoryId } = await linked()

    await queue.enqueue(INDEX_REPOSITORY_QUEUE, {
      workspaceId,
      repositoryId,
      commitSha: firstCommit,
    })
    await queue.drain(INDEX_REPOSITORY_QUEUE)

    await queue.enqueue(INDEX_REPOSITORY_QUEUE, {
      workspaceId,
      repositoryId,
      commitSha: secondCommit,
      changedPaths: ['src/widget.ts', 'app/settings/page.tsx'],
    })
    await queue.drain(INDEX_REPOSITORY_QUEUE)

    const [run] = await db.admin.query<{ stats: Record<string, number> }>(
      `SELECT stats FROM repo_index_runs WHERE workspace_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [workspaceId],
    )
    // The new file and the changed one; the three untouched files were skipped
    // by content hash, whatever the push claimed.
    expect(run!.stats.filesIndexed).toBe(2)
    expect(run!.stats.filesUnchanged).toBe(4)

    expect((await filesIn(workspaceId)).map((f) => f.path)).toContain('app/settings/page.tsx')
  })

  it('CLAUDE.md §6.7: the same push delivered twice indexes once', async () => {
    const { workspaceId, repositoryId } = await linked()
    const key = `${repositoryId}:${firstCommit}`

    // A source retrying its webhook, which every git host does.
    await queue.enqueue(
      INDEX_REPOSITORY_QUEUE,
      { workspaceId, repositoryId, commitSha: firstCommit },
      { idempotencyKey: key },
    )
    await queue.enqueue(
      INDEX_REPOSITORY_QUEUE,
      { workspaceId, repositoryId, commitSha: firstCommit },
      { idempotencyKey: key },
    )
    await queue.drain(INDEX_REPOSITORY_QUEUE)

    const runs = await db.admin.query(
      `SELECT 1 FROM repo_index_runs WHERE workspace_id = $1`,
      [workspaceId],
    )
    expect(runs, 'a redelivered push must not index twice').toHaveLength(1)
  })

  it('CLAUDE.md §6.7: even a job that genuinely runs twice re-embeds nothing', async () => {
    // The second half of idempotency: the key collapses deliveries, but a key
    // cannot survive a queue flush, so running the same work twice must also be
    // free. Both are needed; neither is sufficient.
    const { workspaceId, repositoryId } = await linked()
    const payload = { workspaceId, repositoryId, commitSha: firstCommit }

    await queue.enqueue(INDEX_REPOSITORY_QUEUE, payload)
    await queue.drain(INDEX_REPOSITORY_QUEUE)
    await queue.enqueue(INDEX_REPOSITORY_QUEUE, payload)
    await queue.drain(INDEX_REPOSITORY_QUEUE)

    const [latest] = await db.admin.query<{ stats: Record<string, number> }>(
      `SELECT stats FROM repo_index_runs WHERE workspace_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [workspaceId],
    )
    expect(latest!.stats.filesIndexed).toBe(0)
    expect(latest!.stats.filesUnchanged).toBe(5)
  })

  it('BRAIN-2: the working copy is removed, even when indexing fails', async () => {
    const { workspaceId, repositoryId } = await linked()
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith('chorus-checkout-'))

    // A commit that is not in the remote: the fetch fails, and the temporary
    // directory must still go. A checked-out copy of a private repository left
    // on a shared host is the failure worth preventing.
    await queue.enqueue(INDEX_REPOSITORY_QUEUE, {
      workspaceId,
      repositoryId,
      commitSha: '0000000000000000000000000000000000000000',
    })
    await queue.drain(INDEX_REPOSITORY_QUEUE)

    const after = readdirSync(tmpdir()).filter((name) => name.startsWith('chorus-checkout-'))
    expect(after.length).toBeLessThanOrEqual(before.length)
    expect(await filesIn(workspaceId)).toHaveLength(0)
  })

  it('NFR-6: a job for a repository that was unlinked fails visibly rather than silently', async () => {
    const { workspaceId, repositoryId } = await linked()
    await db.admin.execute(`UPDATE repositories SET deleted_at = now() WHERE id = $1`, [
      repositoryId,
    ])

    await queue.enqueue(INDEX_REPOSITORY_QUEUE, {
      workspaceId,
      repositoryId,
      commitSha: firstCommit,
    })
    await queue.drain(INDEX_REPOSITORY_QUEUE)

    // Kept on the failed set: "which work failed and why" has to be answerable,
    // and a queue that discards its failures makes an outage invisible.
    const failures = await queue.failed(INDEX_REPOSITORY_QUEUE)
    expect(failures.some((failure) => failure.reason.includes('No such repository'))).toBe(true)
  })

  it('BRAIN-2: a clone token never reaches the working copy', async () => {
    // Git's natural way to authenticate an HTTPS clone is a URL containing the
    // credential, which then lives in `.git/config` for as long as the copy
    // does. The header approach must leave nothing behind.
    const copy = await checkout({
      remote: bareRepo,
      commitSha: firstCommit,
      token: 'ghs_asecretclonetoken',
    })

    try {
      const config = readFileSync(join(copy.path, '.git', 'config'), 'utf8')
      expect(config).not.toContain('ghs_asecretclonetoken')
      expect(config).not.toContain('x-access-token')
    } finally {
      await copy.dispose()
    }
  })

  it('BRAIN-2: a failed checkout does not put the token in its error', async () => {
    // Where a credential actually leaks: git prints the whole command it ran,
    // and that message ends up in a health row an admin reads.
    const failure = await checkout({
      remote: join(bareRepo, 'does-not-exist'),
      commitSha: firstCommit,
      token: 'ghs_asecretclonetoken',
    }).catch((error: unknown) => error as Error)

    expect(failure).toBeInstanceOf(Error)
    expect(JSON.stringify(failure)).not.toContain('ghs_asecretclonetoken')
  })
})
