import { describe, it, expect } from 'vitest'
import type { Signal } from '@chorus/core'
import { extractStatusChanges } from './tracker-webhook.js'

/**
 * TASK-4 — reading status changes out of a tracker delivery (AC2).
 *
 * An issue signal names the issue by its native id (`raw.id`, the id the push
 * stored on the link) and carries the status in `structured.state`. Anything
 * else — a signal that is not an issue, or one with no status — yields nothing,
 * because the mirror must not move a task on a guess.
 */

function issueSignal(over: Partial<Signal> & { raw?: unknown; structured?: unknown }): Signal {
  return {
    source: 'linear',
    externalId: 'linear:issue:ACME-7',
    kind: 'issue',
    text: null,
    structured: { state: 'In Progress' },
    author: null,
    occurredAt: new Date('2026-09-01T09:00:00.000Z'),
    url: 'https://linear.app/acme/ACME-7',
    permissions: { visibility: 'public', scopeIds: [] },
    raw: { id: 'lin-issue-1' },
    ...over,
  } as Signal
}

describe('TASK-4 extractStatusChanges', () => {
  it('TASK-4: reads the issue’s native id and status from an issue signal', () => {
    expect(extractStatusChanges([issueSignal({})])).toEqual([
      { externalId: 'lin-issue-1', externalStatus: 'In Progress' },
    ])
  })

  it('TASK-4: ignores signals that are not issues', () => {
    const comment = issueSignal({ kind: 'issue_comment' })
    expect(extractStatusChanges([comment])).toEqual([])
  })

  it('TASK-4: ignores an issue whose delivery carried no status', () => {
    expect(extractStatusChanges([issueSignal({ structured: {} })])).toEqual([])
    expect(extractStatusChanges([issueSignal({ raw: {} })])).toEqual([])
  })
})
