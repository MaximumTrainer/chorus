import { describe, it, expect } from 'vitest'
import { detectRepository } from './detect.js'
import type { WalkedFile } from './walk.js'

/**
 * BRAIN-2 AC3 — the route map.
 *
 * "The route map is the least portable part. Treat each framework as a strategy
 * with its own fixture repository." So each framework below is its own fixture,
 * and the assertion is always the same shape: a representative route resolves
 * to the component that actually renders it.
 *
 * This is what lets a captured URL become a code pointer (EXT-5) and a prototype
 * start from the real page. A route map that is *nearly* right is worse than
 * none: it sends someone confidently to the wrong file.
 */

const file = (path: string, text = 'export default function Page() { return null }'): WalkedFile => ({
  path,
  text,
  bytes: text.length,
  contentHash: 'x'.repeat(64),
})

const pkg = (content: unknown): WalkedFile => ({
  path: 'package.json',
  text: JSON.stringify(content),
  bytes: 0,
  contentHash: 'x'.repeat(64),
})

/** `{ '/route': 'file' }`, which is what every assertion here compares. */
const mapOf = (files: WalkedFile[]): Record<string, string> =>
  Object.fromEntries(detectRepository(files).routes.map((r) => [r.pattern, r.componentPath]))

describe('BRAIN-2 AC3 route maps', () => {
  it('BRAIN-2 AC3: Next.js App Router — nested, dynamic and grouped routes', () => {
    const files = [
      pkg({ name: 'app', dependencies: { next: '^14.0.0', react: '^18' } }),
      file('app/page.tsx'),
      file('app/about/page.tsx'),
      file('app/blog/[slug]/page.tsx'),
      file('app/(marketing)/pricing/page.tsx'),
      file('app/shop/[...all]/page.tsx'),
      file('app/layout.tsx'),
      file('app/blog/loading.tsx'),
    ]

    expect(detectRepository(files).framework).toBe('nextjs-app')
    expect(mapOf(files)).toEqual({
      '/': 'app/page.tsx',
      '/about': 'app/about/page.tsx',
      '/blog/:slug': 'app/blog/[slug]/page.tsx',
      // A group in parentheses organises files without appearing in the URL.
      // Including it would produce a route that 404s.
      '/pricing': 'app/(marketing)/pricing/page.tsx',
      '/shop/*': 'app/shop/[...all]/page.tsx',
    })
  })

  it('BRAIN-2 AC3: only page files become routes, not layouts or loading states', () => {
    // `layout.tsx` renders at a path but is not the page. Mapping it would send
    // a reader to the chrome rather than the content they asked about.
    const files = [
      pkg({ name: 'app', dependencies: { next: '^14' } }),
      file('app/layout.tsx'),
      file('app/error.tsx'),
      file('app/dashboard/page.tsx'),
    ]
    expect(mapOf(files)).toEqual({ '/dashboard': 'app/dashboard/page.tsx' })
  })

  it('BRAIN-2 AC3: Next.js Pages Router — index, dynamic and catch-all', () => {
    const files = [
      pkg({ name: 'app', dependencies: { next: '^13' } }),
      file('pages/index.tsx'),
      file('pages/about.tsx'),
      file('pages/blog/[slug].tsx'),
      file('pages/shop/[...all].tsx'),
      file('pages/_app.tsx'),
      file('pages/api/health.ts'),
    ]

    expect(detectRepository(files).framework).toBe('nextjs-pages')
    expect(mapOf(files)).toEqual({
      '/': 'pages/index.tsx',
      '/about': 'pages/about.tsx',
      '/blog/:slug': 'pages/blog/[slug].tsx',
      '/shop/*': 'pages/shop/[...all].tsx',
      // API routes are real routes and worth mapping; `_app` is not a route
      // at all.
      '/api/health': 'pages/api/health.ts',
    })
  })

  it('BRAIN-2 AC3: SvelteKit — +page files, with its own dynamic syntax', () => {
    const files = [
      pkg({ name: 'app', devDependencies: { '@sveltejs/kit': '^2.0.0' } }),
      file('src/routes/+page.svelte'),
      file('src/routes/about/+page.svelte'),
      file('src/routes/blog/[slug]/+page.svelte'),
      file('src/routes/+layout.svelte'),
      file('src/routes/blog/[slug]/+page.server.ts'),
    ]

    expect(detectRepository(files).framework).toBe('sveltekit')
    expect(mapOf(files)).toEqual({
      '/': 'src/routes/+page.svelte',
      '/about': 'src/routes/about/+page.svelte',
      '/blog/:slug': 'src/routes/blog/[slug]/+page.svelte',
    })
  })

  it('BRAIN-2 AC3: Nuxt — pages directory, with its colon syntax', () => {
    const files = [
      pkg({ name: 'app', devDependencies: { nuxt: '^3.0.0' } }),
      file('pages/index.vue'),
      file('pages/about.vue'),
      file('pages/blog/[slug].vue'),
    ]

    expect(detectRepository(files).framework).toBe('nuxt')
    expect(mapOf(files)).toEqual({
      '/': 'pages/index.vue',
      '/about': 'pages/about.vue',
      '/blog/:slug': 'pages/blog/[slug].vue',
    })
  })

  it('BRAIN-2 AC3: React Router — configuration-based, read from the source', () => {
    // The other half of AC3. There is no directory to walk here: the routes are
    // values in a file, so the strategy has to read the code.
    const routerSource = [
      `import { createBrowserRouter } from 'react-router-dom'`,
      `import Home from './pages/Home'`,
      `import Settings from './pages/Settings'`,
      ``,
      `export const router = createBrowserRouter([`,
      `  { path: '/', element: <Home /> },`,
      `  { path: '/settings', element: <Settings /> },`,
      `  { path: '/users/:id', element: <UserDetail /> },`,
      `])`,
    ].join('\n')

    const files = [
      pkg({ name: 'app', dependencies: { 'react-router-dom': '^6.20.0' } }),
      { path: 'src/router.tsx', text: routerSource, bytes: 0, contentHash: 'x'.repeat(64) },
      file('src/pages/Home.tsx'),
      file('src/pages/Settings.tsx'),
    ]

    expect(detectRepository(files).framework).toBe('react-router')
    const map = mapOf(files)
    expect(Object.keys(map).sort()).toEqual(['/', '/settings', '/users/:id'])
    // Where the element resolves to a file we can name, it is named; where it
    // does not, the route still exists and points at the file that declares it.
    expect(map['/']).toBe('src/router.tsx')
  })

  it('BRAIN-2 AC3: a repository with no routing framework yields an empty map', () => {
    // An empty map is honest. A populated one from guesswork sends people to
    // the wrong file with confidence, which is the failure worth avoiding.
    const files = [pkg({ name: 'lib', dependencies: { lodash: '^4' } }), file('src/index.ts')]

    expect(detectRepository(files).framework).toBeNull()
    expect(detectRepository(files).routes).toEqual([])
  })

  it('BRAIN-2 AC3: App Router wins when a repository has both directories', () => {
    // Next.js allows both during a migration, and `app/` takes precedence for
    // any path they both define.
    const files = [
      pkg({ name: 'app', dependencies: { next: '^14' } }),
      file('app/page.tsx'),
      file('pages/legacy.tsx'),
    ]

    expect(detectRepository(files).framework).toBe('nextjs-app')
    expect(mapOf(files)['/']).toBe('app/page.tsx')
  })

  it('BRAIN-2 AC3: a monorepo app under a subdirectory is still mapped', () => {
    // Most real repositories are not a single app at the root, and a strategy
    // anchored to the root would find nothing in the ones that matter most.
    const files = [
      pkg({ name: 'root', workspaces: ['apps/*'] }),
      {
        path: 'apps/web/package.json',
        text: JSON.stringify({ name: 'web', dependencies: { next: '^14' } }),
        bytes: 0,
        contentHash: 'x'.repeat(64),
      },
      file('apps/web/app/page.tsx'),
      file('apps/web/app/settings/page.tsx'),
    ]

    expect(mapOf(files)).toEqual({
      '/': 'apps/web/app/page.tsx',
      '/settings': 'apps/web/app/settings/page.tsx',
    })
  })

  it('BRAIN-2 AC3: detection is deterministic', () => {
    const files = [
      pkg({ name: 'app', dependencies: { next: '^14' } }),
      file('app/b/page.tsx'),
      file('app/a/page.tsx'),
    ]
    expect(detectRepository(files).routes).toEqual(detectRepository(files).routes)
  })
})
