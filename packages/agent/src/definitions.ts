import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { loadPromptDirectory } from '@chorus/llm'
import {
  ConfigurationError,
  validateDefinition,
  WorkflowDefinitionSchema,
  type DefinitionProblem,
  type ValidationEnvironment,
  type WorkflowDefinition,
} from '@chorus/core'
import { shippedTools } from './tools/index.js'

/**
 * The workflow registry (AGENT-1 AC1, architecture.md §11.1).
 *
 * > **Then** it fails at startup with a message naming the workflow and the
 * > problem — never at run time.
 *
 * "Never at run time" is the requirement, and the reason is the order things
 * happen in: a workflow that dies at step four because step four names a tool
 * that does not exist has already run steps one to three, and one of those may
 * have written something. A definition is data; data that is wrong should be
 * caught while it is still only data.
 *
 * Definitions are YAML files, like prompts, and for the same reason: the people
 * most likely to read and change one are not necessarily reading the code
 * around it, and a diff on a workflow should be legible on its own.
 */

/** Where the shipped definitions live, relative to this file's package. */
export const WORKFLOW_ROOT = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'workflows',
  'definitions',
)

export interface WorkflowRegistry {
  /** A specific version. A run pins one, so old versions stay reachable (AC4). */
  get(name: string, version: number): WorkflowDefinition
  /** The highest version of a workflow — what a new run starts on. */
  latest(name: string): WorkflowDefinition
  names(): string[]
  all(): readonly WorkflowDefinition[]
}

/**
 * Whether a path under the definition root is a definition.
 *
 * Documentation and drafts live alongside definitions, so `README.md` and any
 * `_`-prefixed file or directory are excluded by convention — the same rule
 * prompts use. Excluding by an explicit rule rather than by "ignore anything
 * that fails to parse" is deliberate: the latter would make a workflow with a
 * typo in it silently stop existing, and the first symptom would be a router
 * that cannot find it.
 */
export function isDefinitionPath(relativePath: string): boolean {
  if (!relativePath.endsWith('.yaml') && !relativePath.endsWith('.yml')) return false
  const segments = relativePath.split('/')
  return !segments.some((segment) => segment.startsWith('_'))
}

function walk(root: string, current = root, found: string[] = []): string[] {
  for (const entry of readdirSync(current)) {
    const absolute = join(current, entry)
    if (statSync(absolute).isDirectory()) {
      walk(root, absolute, found)
      continue
    }
    if (isDefinitionPath(relative(root, absolute).split(sep).join('/'))) found.push(absolute)
  }
  return found
}

/**
 * Loads and validates every definition under a root.
 *
 * Every problem in every file is collected before anything is thrown. A loader
 * that threw on the first bad file would make fixing a directory of workflows a
 * restart-per-typo exercise, which is exactly the experience AC1's "reports the
 * problem" is meant to avoid.
 */
export function loadWorkflowDirectory(
  root: string,
  environment: ValidationEnvironment,
): WorkflowRegistry {
  const problems: DefinitionProblem[] = []
  const byKey = new Map<string, WorkflowDefinition>()

  for (const path of walk(root)) {
    const file = relative(root, path).split(sep).join('/')

    let parsed: unknown
    try {
      parsed = parseYaml(readFileSync(path, 'utf8'))
    } catch (cause) {
      problems.push({ workflow: file, message: `is not parseable YAML: ${String(cause)}` })
      continue
    }

    const result = WorkflowDefinitionSchema.safeParse(parsed)
    if (!result.success) {
      for (const issue of result.error.issues) {
        const at = issue.path.length > 0 ? ` at ${issue.path.join('.')}` : ''
        problems.push({ workflow: file, message: `${issue.message}${at}` })
      }
      continue
    }

    const definition = result.data
    const key = `${definition.name}@${definition.version}`
    if (byKey.has(key)) {
      // Whichever loaded last would win, and which one that is depends on
      // filesystem order — a difference between machines that nothing reports.
      problems.push({ workflow: file, message: `defines ${key}, which is already defined` })
      continue
    }
    byKey.set(key, definition)

    problems.push(...validateDefinition(definition, environment))
  }

  if (problems.length > 0) {
    throw new ConfigurationError(
      `${problems.length} problem${problems.length === 1 ? '' : 's'} in the workflow ` +
        `definitions under ${root}:\n` +
        problems.map((problem) => `  ${problem.workflow}: ${problem.message}`).join('\n'),
      { root, problems },
    )
  }

  const byName = new Map<string, WorkflowDefinition[]>()
  for (const definition of byKey.values()) {
    const versions = byName.get(definition.name) ?? []
    versions.push(definition)
    byName.set(definition.name, versions)
  }
  for (const versions of byName.values()) {
    versions.sort((a, b) => a.version - b.version)
  }

  const known = (name: string): WorkflowDefinition[] => {
    const versions = byName.get(name)
    if (!versions || versions.length === 0) {
      throw new ConfigurationError(
        `No workflow named "${name}" is loaded. Loaded: ${[...byName.keys()].join(', ') || 'none'}`,
        { name },
      )
    }
    return versions
  }

  return {
    get(name, version) {
      const found = known(name).find((definition) => definition.version === version)
      if (!found) {
        // Named rather than silently falling back to the latest: a run that
        // resumed onto a different version than it started on would violate
        // AC4 while looking like it worked.
        throw new ConfigurationError(
          `Workflow "${name}" has no version ${version}. It has: ` +
            known(name)
              .map((definition) => definition.version)
              .join(', '),
          { name, version },
        )
      }
      return found
    },
    latest(name) {
      const versions = known(name)
      // Highest, not last-loaded: directory order is not a fact about versions.
      return versions[versions.length - 1]!
    },
    names() {
      return [...byName.keys()].sort()
    },
    all() {
      return [...byKey.values()]
    },
  }
}

/**
 * The workflows this platform ships, loaded and validated.
 *
 * The one place that answers "what ships": the definitions on disk, checked
 * against the tools that are actually registered and the prompts that are
 * actually there. Called at process boot so a definition naming a prompt
 * somebody renamed stops the process, rather than failing at step four of a run
 * that has already done steps one to three (AC1).
 */
export function builtInWorkflows(options: { allowedHosts?: readonly string[] } = {}): WorkflowRegistry {
  return loadWorkflowDirectory(WORKFLOW_ROOT, {
    tools: shippedTools({ allowedHosts: options.allowedHosts ?? [] }).map((tool) => tool.name),
    prompts: loadPromptDirectory(join(WORKFLOW_ROOT, '..', 'prompts')).ids(),
  })
}
