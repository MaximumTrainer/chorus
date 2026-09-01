import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadPromptDirectory, isPromptPath } from '@chorus/llm'

const promptRoot = join(import.meta.dirname, '..', '..', 'workflows', 'prompts')

/** Counts prompt files using the same predicate the loader uses, so the two cannot drift. */
const countPromptFiles = (dir: string, prefix = ''): number => {
  let total = 0
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const rel = prefix ? `${prefix}/${entry}` : entry
    if (statSync(full).isDirectory()) total += countPromptFiles(full, rel)
    else if (isPromptPath(rel)) total += 1
  }
  return total
}

/**
 * NFR-2 AC4 — every prompt used in production is a versioned file.
 *
 * The parser this leans on is exhaustively unit-tested in packages/llm, so a
 * green result here means every real prompt was parsed and accepted, not that
 * the check is inert. While the directory is still empty this stands as a
 * guard: the first malformed prompt added will fail the build.
 */
describe('NFR-2 AC4 production prompts', () => {
  it('NFR-2 AC4: the prompt directory exists where architecture.md §9.4 says it does', () => {
    expect(existsSync(promptRoot), `expected prompts at ${promptRoot}`).toBe(true)
  })

  it('NFR-2 AC4: every prompt file parses, is versioned, and its id matches its path', () => {
    // loadPromptDirectory throws on missing front-matter, missing or
    // non-integer version, empty body, or an id that has drifted from its path.
    const registry = loadPromptDirectory(promptRoot)
    expect(registry.ids().length).toBe(countPromptFiles(promptRoot))
  })

  it('NFR-2 AC4: no two prompts share an id', () => {
    const ids = loadPromptDirectory(promptRoot).ids()
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('NFR-2 AC4: every prompt hash is stable and full-length, so runs can pin templates', () => {
    const registry = loadPromptDirectory(promptRoot)
    for (const id of registry.ids()) {
      expect(registry.get(id).hash, id).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})
