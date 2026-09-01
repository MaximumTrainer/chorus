import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** A TypeScript source file, read once so rules can be pure functions over it. */
export interface SourceFile {
  /** Repo-relative, forward-slashed, e.g. `packages/llm/src/router.ts`. */
  readonly path: string
  readonly text: string
}

export interface BoundaryViolation {
  readonly rule: string
  readonly file: string
  readonly detail: string
}

/**
 * A rule is scoped to the files it applies to, then forbids either imports
 * matching a pattern, or raw content matching a pattern.
 */
export interface BoundaryRule {
  readonly id: string
  /** Why this rule exists, shown when it fires. */
  readonly rationale: string
  /** Files the rule applies to. */
  readonly appliesTo: RegExp
  /** Files exempted — the layer that is allowed to do the forbidden thing. */
  readonly except?: readonly RegExp[]
  /** Import specifiers that may not appear. */
  readonly forbidImports?: readonly RegExp[]
  /** Raw text that may not appear. */
  readonly forbidContent?: readonly RegExp[]
}

/**
 * The rule engine's own fixtures are quoted strings that look exactly like the
 * imports they forbid — necessarily so, since they are what prove the rules
 * fire. Exempted by exact path rather than by exempting all test files, so a
 * genuine provider-SDK import in any other test still fails.
 */
const RULE_ENGINE_FIXTURES = /^packages\/testing\/src\/boundaries\.test\.ts$/

const SOURCE_ROOTS = ['apps', 'packages'] as const
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.turbo', 'build', '__cassettes__'])

/** Read every TypeScript source file under the workspace's code roots. */
export function collectSourceFiles(root: string): SourceFile[] {
  const files: SourceFile[] = []

  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
        files.push({
          path: relative(root, full).split(sep).join('/'),
          text: readFileSync(full, 'utf8'),
        })
      }
    }
  }

  for (const dirName of SOURCE_ROOTS) walk(join(root, dirName))
  return files
}

/**
 * Import specifiers in a source file: static imports, re-exports, dynamic
 * imports and require calls. Deliberately regex-based — a full parse would be
 * more precise but this runs on every pull request and must stay fast.
 */
export function extractImports(text: string): string[] {
  const specifiers: string[] = []
  const patterns = [
    /(?:^|\n)\s*import\s[^'"\n]*from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s[^'"\n]*from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1])
    }
  }
  return specifiers
}

/** Strip comments and string-literal noise before scanning content rules. */
function withoutCommentsAndImports(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1')
    .replace(/(?:^|\n)\s*(?:import|export)\s[^\n]*from\s*['"][^'"]+['"];?/g, '')
}

export function checkBoundaries(
  files: readonly SourceFile[],
  rules: readonly BoundaryRule[],
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = []

  for (const rule of rules) {
    for (const file of files) {
      if (!rule.appliesTo.test(file.path)) continue
      if (rule.except?.some((exempt) => exempt.test(file.path))) continue

      if (rule.forbidImports) {
        for (const specifier of extractImports(file.text)) {
          const hit = rule.forbidImports.find((pattern) => pattern.test(specifier))
          if (hit) {
            violations.push({
              rule: rule.id,
              file: file.path,
              detail: `imports "${specifier}"`,
            })
          }
        }
      }

      if (rule.forbidContent) {
        const scannable = withoutCommentsAndImports(file.text)
        for (const pattern of rule.forbidContent) {
          const match = scannable.match(pattern)
          if (match) {
            violations.push({
              rule: rule.id,
              file: file.path,
              detail: `contains "${match[0]}"`,
            })
          }
        }
      }
    }
  }

  return violations
}

/** Provider SDKs that may only be imported by packages/llm (ADR-0005). */
const PROVIDER_SDKS = [
  /^@anthropic-ai\//,
  /^openai$/,
  /^@google\/(generative-ai|genai)$/,
  /^@azure\/openai$/,
  /^ollama$/,
  /^@ai-sdk\//,
  /^ai$/,
  /^cohere-ai$/,
  /^@mistralai\//,
] as const

/** Database drivers that may only be imported by packages/db (ADR-0003). */
const DATABASE_DRIVERS = [/^pg$/, /^postgres$/, /^drizzle-orm/, /^@electric-sql\/pglite$/] as const

/**
 * Concrete model identifiers. A model name in feature code means the router was
 * bypassed, which is how provider-agnosticism is lost one call at a time.
 */
const MODEL_NAMES = [
  /\bclaude-[a-z0-9.-]*\d/i,
  /\bgpt-[0-9][a-z0-9.-]*/i,
  /\bgemini-[0-9][a-z0-9.-]*/i,
  /\btext-embedding-[a-z0-9-]+/i,
] as const

/**
 * The boundaries of architecture.md §7 and ADRs 0003 and 0005, as data.
 * Adding a package does not require touching this list; violating it does.
 */
export const CHORUS_BOUNDARY_RULES: readonly BoundaryRule[] = [
  {
    id: 'NFR-2: no provider SDK outside packages/llm',
    rationale:
      'Every model call goes through one provider-agnostic interface (ADR-0005). ' +
      'A provider SDK imported elsewhere is vendor lock-in arriving by accumulation.',
    appliesTo: /^(apps|packages)\//,
    except: [/^packages\/llm\//, RULE_ENGINE_FIXTURES],
    forbidImports: PROVIDER_SDKS,
  },
  {
    id: 'NFR-2: no concrete model name outside packages/llm',
    rationale:
      'Models are resolved from workspace configuration by task type. A model ' +
      'name in feature code means the router was bypassed.',
    appliesTo: /^(apps|packages)\/.*\/src\//,
    except: [/^packages\/llm\//, /\.test\.ts$/],
    forbidContent: MODEL_NAMES,
  },
  {
    id: 'NFR-3: no database driver outside packages/db',
    rationale:
      'Tenancy is enforced by row-level security bound to a session variable, ' +
      'which only the withTenant accessor sets (ADR-0003). A raw connection ' +
      'obtained elsewhere bypasses every policy.',
    appliesTo: /^(apps|packages)\//,
    except: [/^packages\/db\//, RULE_ENGINE_FIXTURES],
    forbidImports: DATABASE_DRIVERS,
  },
  {
    id: 'architecture.md §7: packages/core depends on nothing internal',
    rationale:
      'core is the shared vocabulary. If it depends on a feature package, the ' +
      'dependency graph has a cycle and nothing can be reasoned about in isolation.',
    appliesTo: /^packages\/core\//,
    except: [RULE_ENGINE_FIXTURES],
    forbidImports: [/^@chorus\/(?!config)/],
  },
  {
    id: 'architecture.md §7: db and llm depend only on core',
    rationale: 'The foundation layers must not reach upward into features.',
    appliesTo: /^packages\/(db|llm)\//,
    except: [RULE_ENGINE_FIXTURES],
    forbidImports: [/^@chorus\/(?!core$|config$)/],
  },
  {
    id: 'architecture.md §7: packages never import from apps',
    rationale: 'Apps depend on packages, never the reverse.',
    appliesTo: /^packages\//,
    except: [RULE_ENGINE_FIXTURES],
    forbidImports: [/^@chorus\/(web|api|collab|worker|sandbox-runner|extension|chat-surfaces)$/],
  },
]
