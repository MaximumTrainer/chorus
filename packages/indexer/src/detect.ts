import type { WalkedFile } from './walk.js'

/**
 * What a repository tells you about itself (BRAIN-2 AC3, AC4).
 *
 * Everything here is read from files the repository already commits; nothing is
 * inferred by a model. Same argument as the deterministic entity pass: a
 * `pnpm-lock.yaml` *means* pnpm, so certainty is free and a guess would be both
 * slower and worse.
 *
 * The consumer is the brief builder (CODE-2), which puts these in front of a
 * coding agent. That makes a *wrong* answer more expensive than a missing one:
 * an agent given the wrong test command runs it, watches it fail for reasons
 * unrelated to its change, and wastes the run. So every detector here returns
 * null rather than guessing.
 */

export type Framework =
  | 'nextjs-app'
  | 'nextjs-pages'
  | 'sveltekit'
  | 'nuxt'
  | 'react-router'

export type PackageManager = 'pnpm' | 'yarn' | 'npm' | 'bun'

export interface RouteEntry {
  /** `/blog/:slug`, normalised across frameworks so consumers learn one syntax. */
  readonly pattern: string
  /** Repository-relative path of the component that renders it. */
  readonly componentPath: string
}

export interface Conventions {
  readonly packageManager: PackageManager | null
  readonly testCommand: string | null
  readonly lintCommand: string | null
  readonly formatCommand: string | null
  readonly buildCommand: string | null
  readonly contributionGuide: string | null
  /** AGENTS.md, CLAUDE.md — house rules a run that ignores them will break. */
  readonly agentInstructions: readonly string[]
  /** Workspace globs, or null if this is not a monorepo. */
  readonly monorepo: readonly string[] | null
}

export type DesignSystem =
  | { readonly kind: 'package'; readonly name: string }
  | { readonly kind: 'local'; readonly path: string }

export interface DetectedRepository {
  readonly framework: Framework | null
  readonly routes: readonly RouteEntry[]
  readonly conventions: Conventions
  readonly designSystem: DesignSystem | null
  readonly previewProvider: 'vercel' | 'netlify' | 'cloudflare' | null
}

interface Manifest {
  readonly path: string
  /** The directory it governs — '' at the root, `apps/web` in a monorepo. */
  readonly dir: string
  readonly json: Record<string, unknown>
}

function parseManifests(files: readonly WalkedFile[]): Manifest[] {
  const manifests: Manifest[] = []
  for (const file of files) {
    if (!file.path.endsWith('package.json')) continue
    if (file.path.includes('node_modules/')) continue
    try {
      const json = JSON.parse(file.text) as Record<string, unknown>
      manifests.push({
        path: file.path,
        dir: file.path === 'package.json' ? '' : file.path.slice(0, -'/package.json'.length),
        json,
      })
    } catch {
      // Some repositories commit a broken or templated manifest. Everything
      // else is still detectable, and throwing here would fail the whole index.
    }
  }
  // Root first, so it wins where two manifests disagree.
  return manifests.sort((a, b) => a.dir.length - b.dir.length)
}

const dependenciesOf = (manifest: Manifest): Record<string, string> => ({
  ...((manifest.json.dependencies as Record<string, string>) ?? {}),
  ...((manifest.json.devDependencies as Record<string, string>) ?? {}),
})

// ---------------------------------------------------------------------------
// Conventions (AC4)
// ---------------------------------------------------------------------------

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

function detectConventions(files: readonly WalkedFile[], manifests: Manifest[]): Conventions {
  const paths = new Set(files.map((file) => file.path))

  // The lockfile, not the `packageManager` field: that field is aspirational
  // and often stale, while a lockfile is what the repository actually has.
  // Telling an agent to run `npm ci` in a pnpm workspace wastes the whole run.
  const packageManager = LOCKFILES.find(([lockfile]) => paths.has(lockfile))?.[1] ?? null

  const root = manifests.find((manifest) => manifest.dir === '')
  const scripts = (root?.json.scripts as Record<string, string> | undefined) ?? {}

  // Prefixed with the runner, because that is what an agent has to type — the
  // bare script name is not a runnable command.
  const command = (name: string): string | null =>
    scripts[name] && packageManager ? `${packageManager} run ${name}` : null

  const workspaces = root?.json.workspaces
  const pnpmWorkspace = files.find((file) => file.path === 'pnpm-workspace.yaml')
  const globs = Array.isArray(workspaces)
    ? (workspaces as string[])
    : pnpmWorkspace
      ? [...pnpmWorkspace.text.matchAll(/^\s*-\s*["']?([^"'\n]+)["']?\s*$/gm)].map((m) => m[1]!.trim())
      : null

  // Only at the root: a CLAUDE.md deep in `docs/` is documentation about
  // agents, not instructions to them.
  const agentInstructions = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', 'GEMINI.md'].filter((name) =>
    paths.has(name),
  )

  return {
    packageManager,
    testCommand: command('test'),
    lintCommand: command('lint'),
    formatCommand: command('format'),
    buildCommand: command('build'),
    contributionGuide: ['CONTRIBUTING.md', 'CONTRIBUTING.rst', 'docs/CONTRIBUTING.md'].find((name) =>
      paths.has(name),
    ) ?? null,
    agentInstructions,
    monorepo: globs && globs.length > 0 ? globs : null,
  }
}

// ---------------------------------------------------------------------------
// Design system and preview provider (AC4)
// ---------------------------------------------------------------------------

/** Names that mean "this is the component library", not merely "UI adjacent". */
const DESIGN_SYSTEM_HINTS = ['design-system', 'ui-kit', 'component-library', 'design-tokens']

/** Where a local component library conventionally lives. */
const LOCAL_UI_DIRS = ['src/components/ui', 'components/ui', 'src/ui', 'packages/ui/src']

function detectDesignSystem(
  files: readonly WalkedFile[],
  manifests: Manifest[],
): DesignSystem | null {
  for (const manifest of manifests) {
    const named = Object.keys(dependenciesOf(manifest)).find((name) =>
      DESIGN_SYSTEM_HINTS.some((hint) => name.includes(hint)),
    )
    if (named) return { kind: 'package', name: named }
  }

  // A prototype that reuses the real design system looks like the product; one
  // that does not looks like a wireframe of it.
  for (const directory of LOCAL_UI_DIRS) {
    const inside = files.filter((file) => file.path.startsWith(`${directory}/`))
    // More than one file, so a stray `ui/index.ts` is not mistaken for a
    // library.
    if (inside.length > 1) return { kind: 'local', path: directory }
  }
  return null
}

function detectPreviewProvider(
  files: readonly WalkedFile[],
): DetectedRepository['previewProvider'] {
  const paths = new Set(files.map((file) => file.path))
  if (paths.has('vercel.json') || paths.has('.vercel/project.json')) return 'vercel'
  if (paths.has('netlify.toml')) return 'netlify'
  if (paths.has('wrangler.toml') || paths.has('wrangler.jsonc')) return 'cloudflare'
  return null
}

// ---------------------------------------------------------------------------
// Frameworks and routes (AC3)
// ---------------------------------------------------------------------------

/** Strips the extension, so `page.tsx` and `page.jsx` are one rule. */
const withoutExtension = (path: string): string => path.replace(/\.[^./]+$/, '')

/**
 * Turns a directory segment into a route segment.
 *
 * The three cases every file-system router has, in different syntax:
 * catch-all, dynamic, and a group that organises files without appearing in
 * the URL. Including a group would produce a route that 404s.
 */
function segmentOf(segment: string): string | null {
  if (/^\(.*\)$/.test(segment)) return null
  const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment)
  if (catchAll) return '*'
  const dynamic = /^\[(.+)\]$/.exec(segment)
  if (dynamic) return `:${dynamic[1]}`
  return segment
}

function patternFrom(segments: readonly string[]): string {
  const mapped = segments.map(segmentOf).filter((s): s is string => s !== null)
  return mapped.length === 0 ? '/' : `/${mapped.join('/')}`
}

/**
 * A file-system routing strategy: a directory, and which files in it are pages.
 *
 * Declared as data because the three frameworks differ only in those two facts
 * and in how they spell a dynamic segment — and one loop over a table is far
 * easier to keep correct than three near-identical walkers.
 */
interface FileSystemStrategy {
  readonly framework: Framework
  readonly directory: string
  isPage(fileName: string): boolean
  /** Segments contributed by the file itself, beyond its directory. */
  trailing(fileName: string): string[]
}

const FILE_SYSTEM_STRATEGIES: readonly FileSystemStrategy[] = [
  {
    framework: 'nextjs-app',
    directory: 'app',
    // `layout`, `loading` and `error` render at a path but are not the page;
    // mapping them sends a reader to the chrome rather than the content.
    isPage: (name) => /^page\.(tsx|ts|jsx|js)$/.test(name),
    trailing: () => [],
  },
  {
    framework: 'nextjs-pages',
    directory: 'pages',
    isPage: (name) => /^[^_].*\.(tsx|ts|jsx|js)$/.test(name),
    trailing: (name) => {
      const base = withoutExtension(name)
      return base === 'index' ? [] : [base]
    },
  },
  {
    framework: 'sveltekit',
    directory: 'src/routes',
    isPage: (name) => name === '+page.svelte',
    trailing: () => [],
  },
  {
    framework: 'nuxt',
    directory: 'pages',
    isPage: (name) => /\.vue$/.test(name),
    trailing: (name) => {
      const base = withoutExtension(name)
      return base === 'index' ? [] : [base]
    },
  },
]

function detectFramework(files: readonly WalkedFile[], manifests: Manifest[]): Framework | null {
  const paths = files.map((file) => file.path)
  const has = (suffix: string): boolean => paths.some((path) => path.includes(suffix))

  const allDependencies = manifests.reduce<Record<string, string>>(
    (all, manifest) => ({ ...all, ...dependenciesOf(manifest) }),
    {},
  )

  if (allDependencies['nuxt']) return 'nuxt'
  if (allDependencies['@sveltejs/kit']) return 'sveltekit'
  if (allDependencies['next']) {
    // Next.js allows both during a migration, and `app/` takes precedence for
    // any path they both define.
    if (has('app/page.')) return 'nextjs-app'
    if (has('pages/')) return 'nextjs-pages'
    return 'nextjs-app'
  }
  if (allDependencies['react-router-dom'] || allDependencies['react-router']) return 'react-router'
  return null
}

function fileSystemRoutes(
  files: readonly WalkedFile[],
  strategy: FileSystemStrategy,
): RouteEntry[] {
  const routes: RouteEntry[] = []

  for (const file of files) {
    // Matched anywhere in the tree, not only at the root: most real repositories
    // are a monorepo, and a strategy anchored to the root finds nothing in the
    // ones that matter most.
    const marker = `${strategy.directory}/`
    const at = file.path.indexOf(marker)
    if (at === -1) continue
    // Must be a path boundary, so `src/routes` does not match `x/notsrc/routes`.
    if (at > 0 && file.path[at - 1] !== '/') continue

    const inside = file.path.slice(at + marker.length)
    const parts = inside.split('/')
    const fileName = parts.pop()!
    if (!strategy.isPage(fileName)) continue

    routes.push({
      pattern: patternFrom([...parts, ...strategy.trailing(fileName)]),
      componentPath: file.path,
    })
  }

  // Deterministic, and deduplicated: two files claiming one pattern is a
  // repository-level ambiguity, and taking the first keeps the map a function.
  routes.sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0))
  const seen = new Set<string>()
  return routes.filter((route) => !seen.has(route.pattern) && seen.add(route.pattern))
}

/**
 * Configuration-based routing (React Router).
 *
 * The other half of AC3. There is no directory to walk: the routes are values
 * in a file, so this reads the `path:` entries out of whichever file declares
 * the router. Deliberately shallow — it finds the paths and names the file that
 * declares them, rather than resolving each `element` to its component, which
 * would need real module resolution and would be wrong more often than useful.
 */
function configuredRoutes(files: readonly WalkedFile[]): RouteEntry[] {
  const routes: RouteEntry[] = []

  for (const file of files) {
    if (!/\.(tsx|ts|jsx|js)$/.test(file.path)) continue
    if (!/createBrowserRouter|createHashRouter|createMemoryRouter|<Routes>/.test(file.text)) continue

    for (const match of file.text.matchAll(/\bpath:\s*['"]([^'"]+)['"]/g)) {
      const raw = match[1]!
      routes.push({
        pattern: raw.startsWith('/') ? raw : `/${raw}`,
        componentPath: file.path,
      })
    }
  }

  routes.sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0))
  const seen = new Set<string>()
  return routes.filter((route) => !seen.has(route.pattern) && seen.add(route.pattern))
}

export function detectRepository(files: readonly WalkedFile[]): DetectedRepository {
  const manifests = parseManifests(files)
  const framework = detectFramework(files, manifests)

  const strategy = FILE_SYSTEM_STRATEGIES.find((candidate) => candidate.framework === framework)
  const routes = strategy
    ? fileSystemRoutes(files, strategy)
    : framework === 'react-router'
      ? configuredRoutes(files)
      : []

  return {
    framework,
    routes,
    conventions: detectConventions(files, manifests),
    designSystem: detectDesignSystem(files, manifests),
    previewProvider: detectPreviewProvider(files),
  }
}
