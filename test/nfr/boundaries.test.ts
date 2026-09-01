import { describe, it, expect } from 'vitest'
import { collectSourceFiles, checkBoundaries, CHORUS_BOUNDARY_RULES } from '@chorus/testing'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..')

/**
 * NFR-2 AC1 and NFR-3 AC3 — the dependency boundaries of architecture.md §7.
 *
 * Vendor lock-in and tenancy leaks do not arrive by decision; they arrive by
 * accumulation, one import at a time. This suite is the mechanism that makes
 * them impossible rather than discouraged.
 *
 * The rule engine itself is unit-tested against known-bad fixtures in
 * packages/testing, so a green result here means the rules ran and found
 * nothing — not that the rules are inert.
 */
describe('NFR-2 / NFR-3 dependency boundaries', () => {
  const files = collectSourceFiles(root)

  it('NFR-2: the source tree is actually being scanned', () => {
    // Guards against the whole suite passing because the glob matched nothing.
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(CHORUS_BOUNDARY_RULES.map((rule) => [rule.id, rule] as const))(
    '%s',
    (_id, rule) => {
      const violations = checkBoundaries(files, [rule])
      const report = violations
        .map((v) => `  ${v.file}: ${v.detail}`)
        .join('\n')
      expect(violations, `${rule.rationale}\n${report}`).toEqual([])
    },
  )
})
