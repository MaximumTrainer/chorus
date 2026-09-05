import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ConfigurationError } from '@chorus/core'

/**
 * Prompts live in `workflows/prompts/<workflow>/<step>.md` as versioned files
 * with YAML front-matter (architecture.md §9.4, NFR-2 AC4).
 *
 * A prompt is the most behaviour-changing artefact in the system and the least
 * visible when it changes. Making it a file with a recorded hash is what makes
 * a prompt change reviewable, and what lets a run be replayed against the exact
 * template that produced it (NFR-11 AC2).
 */

export class PromptError extends ConfigurationError {
  override readonly type = 'prompt'
}

export interface Prompt {
  readonly id: string
  readonly version: number
  readonly description?: string
  readonly inputs: readonly string[]
  readonly body: string
  /** SHA-256 of the whole file, front-matter included. Recorded on every run. */
  readonly hash: string
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/**
 * Whether a path under the prompt root is a prompt.
 *
 * Documentation lives alongside prompts, so `README.md` and any `_`-prefixed
 * file or directory are excluded by convention. Excluding by an explicit rule
 * rather than by "ignore anything that fails to parse" is deliberate: the
 * latter would hide a genuinely malformed prompt.
 *
 * Exported so the loader and the NFR lint share one definition rather than
 * drifting apart.
 */
export function isPromptPath(relativePath: string): boolean {
  if (!relativePath.endsWith('.md')) return false
  const segments = relativePath.split('/')
  if (segments.some((segment) => segment.startsWith('_'))) return false
  return segments[segments.length - 1] !== 'README.md'
}

export function parsePrompt(path: string, source: string): Prompt {
  const match = FRONT_MATTER.exec(source)
  if (!match) {
    throw new PromptError(
      `Prompt "${path}" has no YAML front-matter. Every prompt declares at least an id and a version.`,
      { path },
    )
  }

  const [, rawFrontMatter = '', rawBody = ''] = match

  let meta: Record<string, unknown>
  try {
    meta = (parseYaml(rawFrontMatter) ?? {}) as Record<string, unknown>
  } catch (cause) {
    throw new PromptError(`Prompt "${path}" has unparseable front-matter`, { path }, { cause })
  }

  if (typeof meta.id !== 'string' || meta.id.trim() === '') {
    throw new PromptError(`Prompt "${path}" is missing a string "id"`, { path })
  }
  if (typeof meta.version !== 'number' || !Number.isInteger(meta.version)) {
    throw new PromptError(
      `Prompt "${path}" is missing an integer "version". Versions are pinned, not approximate.`,
      { path, version: meta.version },
    )
  }
  if (rawBody.trim() === '') {
    throw new PromptError(
      `Prompt "${path}" has an empty body. An empty prompt fails silently at the model.`,
      { path },
    )
  }

  const inputs = Array.isArray(meta.inputs) ? meta.inputs.map(String) : []

  return {
    id: meta.id,
    version: meta.version,
    ...(typeof meta.description === 'string' ? { description: meta.description } : {}),
    inputs,
    body: rawBody.trim(),
    // Hash the whole file: a front-matter change is a behaviour change too.
    hash: createHash('sha256').update(source, 'utf8').digest('hex'),
  }
}

export interface PromptRegistry {
  get(id: string): Prompt
  ids(): string[]
}

/** Load every `.md` prompt under a directory, keyed by id. */
export function loadPromptDirectory(root: string): PromptRegistry {
  const prompts = new Map<string, Prompt>()

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const relPath = relative(root, full).split(sep).join('/')

      if (statSync(full).isDirectory()) {
        if (!entry.startsWith('_')) walk(full)
        continue
      }
      if (!isPromptPath(relPath)) continue
      const prompt = parsePrompt(relPath, readFileSync(full, 'utf8'))
      const expectedId = relPath.replace(/\.md$/, '')

      // The id and the path must agree, or a rename silently orphans every
      // reference to the prompt while both continue to look correct.
      if (prompt.id !== expectedId) {
        throw new PromptError(
          `Prompt id "${prompt.id}" does not match its path "${relPath}" (expected id "${expectedId}")`,
          { path: relPath, id: prompt.id, expectedId },
        )
      }

      prompts.set(prompt.id, prompt)
    }
  }

  walk(root)

  return {
    get(id) {
      const prompt = prompts.get(id)
      if (!prompt) {
        throw new PromptError(
          `Unknown prompt "${id}". Available: ${[...prompts.keys()].sort().join(', ') || '(none)'}`,
          { id },
        )
      }
      return prompt
    },
    ids: () => [...prompts.keys()],
  }
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g

/**
 * Substitute `{{placeholder}}` values.
 *
 * Both directions are strict. A missing value would otherwise render the string
 * "undefined" into a prompt, which the model will faithfully act upon; an
 * unused value almost always means a placeholder was renamed and a call site
 * was missed.
 */
/**
 * Fills a prompt's placeholders, refusing to leave one unfilled.
 *
 * Extra values are allowed. A workflow step is rendered against everything in
 * scope — every earlier step's output — and most prompts name a few of them,
 * so "unused" there is the normal case rather than a mistake.
 *
 * What is never allowed is sending a placeholder. "Write a {{documentType}}
 * about invoices" is answered, plausibly, by any model, and the run succeeds
 * having asked a question nobody wrote — the most expensive kind of silent
 * failure this system can have.
 *
 * One definition of what a placeholder is, shared with the executor, because
 * two of them means a name one side substitutes and the other passes through
 * untouched.
 */
export function fillPrompt(
  prompt: Pick<Prompt, 'id' | 'body'>,
  values: Record<string, unknown>,
): { text: string; used: ReadonlySet<string> } {
  const used = new Set<string>()

  const text = prompt.body.replace(PLACEHOLDER, (_match, name: string) => {
    if (!(name in values)) {
      throw new PromptError(`Prompt "${prompt.id}" needs a value for "${name}"`, {
        id: prompt.id,
        missing: name,
      })
    }
    used.add(name)
    return String(values[name])
  })

  return { text, used }
}

export function renderPrompt(prompt: Prompt, values: Record<string, unknown>): string {
  const { text: rendered, used } = fillPrompt(prompt, values)

  const unused = Object.keys(values).filter((key) => !used.has(key))
  if (unused.length > 0) {
    throw new PromptError(
      `Prompt "${prompt.id}" was given unused values: ${unused.join(', ')}. ` +
        'This usually means a placeholder was renamed.',
      { id: prompt.id, unused },
    )
  }

  return rendered
}
