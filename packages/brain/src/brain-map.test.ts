import { describe, it, expect } from 'vitest'
import { classifyFreshness, STALE_AFTER_DAYS } from './index.js'

/**
 * BRAIN-6 AC3 — freshness classification thresholds.
 *
 * One definition of "stale", shared with the review inbox's stale detector, so
 * the map and the inbox never disagree about the same entity. A brain entity is
 * judged by its newest visible evidence; an external-authority entity by its
 * owning source's own last sync (BRAIN-11 AC3), since Chorus holds no evidence
 * that could make it fresher than the source says it is.
 */
describe('BRAIN-6 freshness classification', () => {
  const now = new Date('2026-11-13T00:00:00Z')
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000)

  it('BRAIN-6 AC3: the map uses the same stale threshold as the stale detector', () => {
    expect(STALE_AFTER_DAYS).toBe(30)
  })

  it('BRAIN-6 AC3: a brain entity with recent evidence is fresh', () => {
    expect(classifyFreshness({ authority: 'brain', lastActivityAt: daysAgo(1), lastSyncedAt: null }, now)).toBe('fresh')
  })

  it('BRAIN-6 AC3: a brain entity whose newest evidence is past the threshold is stale', () => {
    expect(classifyFreshness({ authority: 'brain', lastActivityAt: daysAgo(31), lastSyncedAt: null }, now)).toBe('stale')
  })

  it('BRAIN-6 AC3: exactly at the threshold is still fresh', () => {
    expect(classifyFreshness({ authority: 'brain', lastActivityAt: daysAgo(30), lastSyncedAt: null }, now)).toBe('fresh')
  })

  it('BRAIN-6 AC3: an external entity is judged by its source sync, not by evidence', () => {
    // Old evidence, but the owning source synced it yesterday: fresh.
    expect(
      classifyFreshness({ authority: 'external', lastActivityAt: daysAgo(400), lastSyncedAt: daysAgo(1) }, now),
    ).toBe('fresh')
    // Recent evidence, but the source has not synced it for months: stale.
    expect(
      classifyFreshness({ authority: 'external', lastActivityAt: daysAgo(1), lastSyncedAt: daysAgo(90) }, now),
    ).toBe('stale')
  })

  it('BRAIN-6 AC3: with no timestamp to judge by, freshness is unknown rather than guessed', () => {
    expect(classifyFreshness({ authority: 'external', lastActivityAt: daysAgo(1), lastSyncedAt: null }, now)).toBe(
      'unknown',
    )
    expect(classifyFreshness({ authority: 'brain', lastActivityAt: null, lastSyncedAt: null }, now)).toBe('unknown')
  })

  it('BRAIN-6 AC3: the threshold is configurable', () => {
    expect(
      classifyFreshness({ authority: 'brain', lastActivityAt: daysAgo(10), lastSyncedAt: null }, now, 7),
    ).toBe('stale')
  })
})
