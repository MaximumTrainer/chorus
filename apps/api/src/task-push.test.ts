import { describe, it, expect } from 'vitest'
import { taskContentHash } from './task-push.js'

/**
 * TASK-4 — change detection by content hash (the unit the sync's conflict
 * determination will rest on, AC3).
 *
 * A hash and not a timestamp: a timestamp produces false conflicts under clock
 * skew and misses them under fast edits. So the hash must be stable for the
 * same content and must move for any field a push carries — otherwise a real
 * change would look like none, and the conflict it should raise would be a
 * silent overwrite.
 */

const base = {
  title: 'Split the invoice parser',
  description: { blocks: [{ text: 'do it' }] },
  acceptanceCriteria: [{ text: 'parsing separated from validation' }],
  tags: ['billing', 'parser'],
  status: 'todo',
}

describe('TASK-4 taskContentHash', () => {
  it('TASK-4: the same content hashes the same, regardless of tag order', () => {
    expect(taskContentHash(base)).toBe(
      taskContentHash({ ...base, tags: ['parser', 'billing'] }),
    )
  })

  it('TASK-4: a change to any pushed field moves the hash', () => {
    const h = taskContentHash(base)
    expect(taskContentHash({ ...base, title: 'Rename' })).not.toBe(h)
    expect(taskContentHash({ ...base, description: { blocks: [] } })).not.toBe(h)
    expect(taskContentHash({ ...base, acceptanceCriteria: [{ text: 'other' }] })).not.toBe(h)
    expect(taskContentHash({ ...base, tags: ['billing'] })).not.toBe(h)
    expect(taskContentHash({ ...base, status: 'done' })).not.toBe(h)
  })
})
