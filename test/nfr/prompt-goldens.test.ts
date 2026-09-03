import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadPromptDirectory, renderPrompt } from '@chorus/llm'

const promptRoot = join(import.meta.dirname, '..', '..', 'workflows', 'prompts')
const goldenRoot = join(promptRoot, '_goldens')

/**
 * CLAUDE.md §6.5 — a prompt change updates its golden in the same pull request.
 *
 * That rule is only worth anything if something enforces it, and only useful if
 * the artefact it produces is *readable*. A recorded hash would satisfy the
 * letter of it and tell a reviewer nothing; a rendered sample shows exactly
 * what the model will now be asked, which is the thing actually under review.
 *
 * So every prompt is rendered with recorded sample values and compared against
 * a checked-in file. A deliberate prompt change produces a diff a person can
 * read; an accidental one — a placeholder renamed, a paragraph dropped — fails
 * here rather than in production, where its only symptom would be worse answers.
 */
describe('NFR-2 AC4 prompt goldens', () => {
  const registry = loadPromptDirectory(promptRoot)
  const inputs = JSON.parse(readFileSync(join(goldenRoot, 'inputs.json'), 'utf8')) as Record<
    string,
    Record<string, unknown>
  >

  const ids = registry.ids()

  it('NFR-2 AC4: there is at least one prompt, so this gate is not checking nothing', () => {
    // The prompt directory was empty for the whole of Phase 0. Without this,
    // every assertion below would pass over an empty list.
    expect(ids.length).toBeGreaterThan(0)
  })

  it.each(ids.map((id) => [id] as const))('NFR-2 AC4: %s has recorded sample inputs', (id) => {
    // A prompt with no sample cannot have a golden, and would silently opt out
    // of the whole gate.
    expect(inputs[id], `add sample values for "${id}" to _goldens/inputs.json`).toBeDefined()
  })

  it.each(ids.map((id) => [id] as const))('NFR-2 AC4: %s matches its golden', (id) => {
    const prompt = registry.get(id)
    const rendered = renderPrompt(prompt, inputs[id] ?? {})
    const goldenPath = join(goldenRoot, `${id.replace(/\//g, '__')}.txt`)

    if (!existsSync(goldenPath)) {
      // Written once, on the first run, and committed. Failing here instead
      // would make adding a prompt a guessing game about exact whitespace.
      writeFileSync(goldenPath, rendered, 'utf8')
    }

    expect(readFileSync(goldenPath, 'utf8')).toBe(rendered)
  })

  it('NFR-2 AC4: every golden belongs to a prompt that still exists', () => {
    // A prompt renamed or deleted leaves its golden behind, where it looks like
    // coverage and is not — and the rename is exactly when someone would rely
    // on that coverage most.
    const known = new Set(ids.map((id) => `${id.replace(/\//g, '__')}.txt`))
    const orphans = readdirSync(goldenRoot).filter(
      (entry) => entry.endsWith('.txt') && !known.has(entry),
    )

    expect(orphans, 'delete goldens for prompts that no longer exist').toEqual([])
  })
})
