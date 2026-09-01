import { describe, it, expect } from 'vitest'
import { ulid, isUlid, ulidAt, decodeUlidTime, createIdGen } from './ids.js'

/**
 * architecture.md §4.4 — all primary keys are ULIDs.
 *
 * Sortable so "newest first" needs no secondary index; opaque so no sequential
 * integer ever appears in a URL or an API response, which would leak volume and
 * invite enumeration.
 */
describe('ULID identifiers', () => {
  it('is 26 characters of Crockford base32', () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('is unique across a large batch', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => ulid()))
    expect(ids.size).toBe(10_000)
  })

  it('sorts lexicographically in time order, which is why "newest first" needs no index', () => {
    const early = ulidAt(new Date('2026-01-01T00:00:00Z'))
    const later = ulidAt(new Date('2026-06-01T00:00:00Z'))
    expect([later, early].sort()).toEqual([early, later])
  })

  it('ids generated within the same millisecond still sort monotonically', () => {
    const gen = createIdGen({ now: () => 1_700_000_000_000 })
    const ids = Array.from({ length: 100 }, () => gen())
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(100)
  })

  it('round-trips its timestamp, so an id alone answers "when"', () => {
    const when = new Date('2026-03-15T12:34:56.789Z')
    expect(decodeUlidTime(ulidAt(when))).toEqual(when)
  })

  it('recognises well-formed ids and rejects malformed ones', () => {
    expect(isUlid(ulid())).toBe(true)
    expect(isUlid('')).toBe(false)
    expect(isUlid('too-short')).toBe(false)
    // I, L, O and U are excluded from Crockford base32 to avoid transcription errors.
    expect(isUlid('0'.repeat(25) + 'I')).toBe(false)
    expect(isUlid('0'.repeat(27))).toBe(false)
    expect(isUlid(ulid().toLowerCase())).toBe(false)
  })

  it('contains no sequential integer, so ids leak neither volume nor ordering of unrelated rows', () => {
    const a = ulidAt(new Date('2026-01-01T00:00:00Z'))
    const b = ulidAt(new Date('2026-01-01T00:00:00Z'))
    // Same millisecond, different random component: adjacent creation does not
    // produce adjacent, guessable identifiers.
    expect(a).not.toBe(b)
    expect(a.slice(10)).not.toBe(b.slice(10))
  })

  it('is deterministic when time and randomness are injected, so tests can freeze it', () => {
    const fixed = createIdGen({ now: () => 1_700_000_000_000, random: () => 0 })
    const other = createIdGen({ now: () => 1_700_000_000_000, random: () => 0 })
    expect(fixed()).toBe(other())
  })
})
