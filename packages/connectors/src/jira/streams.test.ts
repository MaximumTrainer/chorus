import { describe, it, expect } from 'vitest'
import type { Signal } from '@chorus/core'
import { edgesFor, issueToSignal, type JiraIssue } from './streams.js'

/**
 * INT-8 AC7 — Jira issue links become edges between Ticket entities.
 *
 * Jira states a link's direction through its type's inward/outward verbs: an
 * `outwardIssue` is the one THIS issue points at (this duplicates it, this
 * blocks it), an `inwardIssue` points at THIS (it duplicates this, it blocks
 * this). The edge is read the same way regardless of which end the pull saw the
 * link from, so the two issues produce one edge, not a contradictory pair.
 */

function signalWithLinks(links: unknown[]): Signal {
  const issue: JiraIssue = {
    id: '10001',
    key: 'ACME-7',
    fields: { summary: 'The deploy step times out', issuelinks: links as never },
  }
  return issueToSignal(issue, 'https://acme.atlassian.net', false)
}

const evidence = { signalExternalId: 'jira:issue:ACME-7', source: 'jira' }

describe('INT-8 issue links → edges (AC7)', () => {
  it('INT-8 AC7: an outward "duplicates" link is a duplicates edge from this issue to the other', () => {
    const edges = edgesFor(
      signalWithLinks([
        { type: { name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' }, outwardIssue: { key: 'ACME-9' } },
      ]),
    )
    expect(edges).toEqual([
      { kind: 'duplicates', fromExternalId: 'jira:issue:ACME-7', toExternalId: 'jira:issue:ACME-9', confidence: 1, evidence },
    ])
  })

  it('INT-8 AC7: an inward "is blocked by" link is a blocks edge from the blocker to this issue', () => {
    const edges = edgesFor(
      signalWithLinks([
        { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'ACME-5' } },
      ]),
    )
    expect(edges).toEqual([
      { kind: 'blocks', fromExternalId: 'jira:issue:ACME-5', toExternalId: 'jira:issue:ACME-7', confidence: 1, evidence },
    ])
  })

  it('INT-8 AC7: link types other than duplicate and blocks are left for later slices', () => {
    const edges = edgesFor(
      signalWithLinks([
        { type: { name: 'Relates', inward: 'relates to', outward: 'relates to' }, outwardIssue: { key: 'ACME-3' } },
      ]),
    )
    expect(edges).toEqual([])
  })

  it('INT-8 AC7: a link with neither end resolves to no edge', () => {
    const edges = edgesFor(
      signalWithLinks([{ type: { name: 'Blocks', outward: 'blocks' } }]),
    )
    expect(edges).toEqual([])
  })

  it('INT-8 AC7: a non-issue signal has no link edges', () => {
    const signal = { ...signalWithLinks([]), kind: 'comment' }
    expect(edgesFor(signal)).toEqual([])
  })
})
