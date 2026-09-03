import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * WP-0.6 — keeping the walking skeleton disposable.
 *
 * plan.md §2.5 names the failure mode precisely:
 *
 * > Label the code as such; **the temptation to keep it is the failure mode.**
 *
 * Throwaway code is not kept by anyone deciding to keep it. It is kept by one
 * small addition at a time, each individually reasonable, until it is load
 * bearing and deleting it is a project. This suite makes each of those
 * additions fail a build, which is the only intervention that works — a comment
 * saying "temporary" has never removed a line of code.
 *
 * When Phase 1 deletes the skeleton, this file goes with it.
 */

const root = join(import.meta.dirname, '..', '..')
const SKELETON = join(root, 'apps', 'api', 'src', 'walking-skeleton')

/** Everything the skeleton is permitted to contain. Adding to this is a decision. */
const PERMITTED = ['README.md', 'ask.ts']

describe('WP-0.6 the walking skeleton stays disposable', () => {
  it('WP-0.6: the skeleton contains only what it was created with', () => {
    if (!existsSync(SKELETON)) return

    // A new file here is how throwaway code becomes a subsystem. If one is
    // genuinely needed, it belongs to the real implementation instead.
    expect(readdirSync(SKELETON).sort()).toEqual([...PERMITTED].sort())
  })

  it('WP-0.6: it stays small enough to delete without thinking about it', () => {
    if (!existsSync(SKELETON)) return

    const lines = readFileSync(join(SKELETON, 'ask.ts'), 'utf8').split('\n').length
    // Not a style rule. Past a few hundred lines the skeleton stops being
    // obviously disposable and starts looking like something with behaviour
    // worth preserving — which is exactly when it survives Phase 1.
    expect(lines, 'the skeleton is growing; it should be shrinking').toBeLessThan(300)
  })

  it('WP-0.6: nothing outside the skeleton imports it', () => {
    if (!existsSync(SKELETON)) return

    // The one thing that would make deletion expensive. `app.ts` mounts it,
    // which is unavoidable and is a single line; anything else is a dependency
    // that has to be unpicked later.
    const sources = readdirSync(join(root, 'apps', 'api', 'src'))
      .filter((name) => name.endsWith('.ts') && name !== 'app.ts')
      .map((name) => readFileSync(join(root, 'apps', 'api', 'src', name), 'utf8'))

    for (const source of sources) {
      expect(source).not.toContain('walking-skeleton')
    }
  })

  it('WP-0.6: it says plainly that it is to be deleted', () => {
    if (!existsSync(SKELETON)) return

    const readme = readFileSync(join(SKELETON, 'README.md'), 'utf8')
    const source = readFileSync(join(SKELETON, 'ask.ts'), 'utf8')

    // Whoever opens this file next must learn what it is from the file itself,
    // not from a plan document they have not read.
    expect(readme).toMatch(/DELETE/i)
    expect(source).toMatch(/DELETE IN PHASE 1/i)
  })

  it('WP-0.6: it declares no prompt in the versioned registry', () => {
    if (!existsSync(SKELETON)) return

    // A prompt in `workflows/prompts/**` is a commitment with a golden fixture
    // behind it (CLAUDE.md §6.5). Putting the skeleton's prompt there would
    // make it look like something to maintain.
    //
    // Checked against the registry's API rather than the directory name, so
    // the file may explain *why* it does not use it — which it should.
    const source = readFileSync(join(SKELETON, 'ask.ts'), 'utf8')
    for (const registryApi of ['loadPromptDirectory', 'renderPrompt', 'parsePrompt']) {
      expect(source, `the skeleton must not enter the prompt registry`).not.toContain(registryApi)
    }
  })

  it('WP-0.6: the acceptance test that proves the journey is not inside the skeleton', () => {
    // The criterion outlives the code that first satisfied it. Keeping the test
    // outside is what makes deleting the skeleton safe rather than a leap.
    expect(
      existsSync(join(root, 'apps', 'api', 'test', 'acceptance', 'walking-skeleton.test.ts')),
    ).toBe(true)
  })
})
