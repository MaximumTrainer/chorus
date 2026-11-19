import { describe, it, expect } from 'vitest'
import { RETENTION_CLASSES, isRetentionClass, parseRetentionDays, retentionCutoff } from './retention.js'
import { ValidationError } from './errors.js'

describe('NFR-4 retention vocabulary', () => {
  it('NFR-4 AC3: names only the data classes Chorus holds today', () => {
    expect(RETENTION_CLASSES).toEqual(['prompts', 'run_traces'])
    expect(isRetentionClass('prompts')).toBe(true)
    expect(isRetentionClass('screenshots')).toBe(false)
    expect(isRetentionClass(undefined)).toBe(false)
  })

  it('NFR-4 AC3: a period is a whole number of days, or null for "keep"', () => {
    expect(parseRetentionDays(30)).toBe(30)
    expect(parseRetentionDays(null)).toBeNull()
  })

  it('NFR-4 AC3: refuses a period that is not a positive whole number of days', () => {
    for (const bad of [0, -1, 1.5, '30', undefined, Number.NaN, 100_000]) {
      expect(() => parseRetentionDays(bad), String(bad)).toThrow(ValidationError)
    }
  })

  it('NFR-4 AC3: the cutoff is exactly the period before now', () => {
    const now = new Date('2026-11-19T00:00:00Z')
    expect(retentionCutoff(now, 7).toISOString()).toBe('2026-11-12T00:00:00.000Z')
  })
})
