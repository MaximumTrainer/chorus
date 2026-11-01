import { describe, it, expect } from 'vitest'
import { ValidationError } from '@chorus/core'
import { chorusStatusFor, externalStatusFor } from './task-sync.js'

/**
 * TASK-4 — the status map, both directions (AC2, AC5).
 *
 * Inbound (`chorusStatusFor`) maps a tracker's status back to a Chorus one, and
 * returns nothing when the map has no entry — an unmapped inbound status is
 * left for a human, not guessed. Outbound (`externalStatusFor`) refuses by name
 * when a Chorus status has no mapping, because the alternative — guessing a
 * target state in someone's tracker — is exactly the silent wrong this
 * requirement exists to prevent (AC5).
 */

const map = { todo: 'Todo', in_progress: 'In Progress', done: 'Done' }

describe('TASK-4 status map', () => {
  it('TASK-4: maps a tracker status back to a Chorus status, case-insensitively', () => {
    expect(chorusStatusFor(map, 'In Progress')).toBe('in_progress')
    expect(chorusStatusFor(map, 'in progress')).toBe('in_progress')
    expect(chorusStatusFor(map, '  Done  ')).toBe('done')
  })

  it('TASK-4: an unmapped tracker status resolves to nothing, rather than a guess', () => {
    expect(chorusStatusFor(map, 'In Review')).toBeUndefined()
  })

  it('TASK-4: a Chorus status with no mapping is refused by name (AC5)', () => {
    expect(externalStatusFor(map, 'done')).toBe('Done')
    try {
      externalStatusFor(map, 'blocked')
      expect.unreachable('an unmapped status must refuse')
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError)
      expect((error as ValidationError).message).toContain('blocked')
    }
  })
})
