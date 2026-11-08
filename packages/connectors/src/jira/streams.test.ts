import { describe, it, expect } from 'vitest'
import type { Signal } from '@chorus/core'
import { candidatesFor, commentsFrom, edgesFor, issueToSignal, type JiraIssue } from './streams.js'

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

const adf = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

function issueWithComments(comments: unknown[]): JiraIssue {
  return {
    id: '10001',
    key: 'ACME-7',
    fields: {
      summary: 'The deploy step times out',
      project: { key: 'ACME', id: 'proj-1' },
      comment: { comments: comments as never },
    },
  }
}

describe('INT-8 Jira comments as signals (source)', () => {
  it('INT-8: each comment becomes an authored signal with its body in Markdown', () => {
    const signal = commentsFrom(
      issueWithComments([
        {
          id: '90001',
          author: { accountId: 'user-3', displayName: 'Katherine Johnson' },
          body: adf('Looks like the **timeout** is the cause.'),
          created: '2026-09-01T10:00:00.000+0000',
          updated: '2026-09-01T10:05:00.000+0000',
        },
      ]),
      'https://acme.atlassian.net',
      false,
    )[0]!

    expect(signal).toMatchObject({
      source: 'jira',
      externalId: 'jira:comment:90001',
      kind: 'comment',
      text: 'Looks like the **timeout** is the cause.',
      author: { externalId: 'user-3', display: 'Katherine Johnson' },
    })
    expect(signal.url).toContain('/browse/ACME-7')
    expect(signal.occurredAt).toEqual(new Date('2026-09-01T10:05:00.000+0000'))
  })

  it('INT-8: a comment signal is scoped to the issue it belongs to', () => {
    const signal = commentsFrom(
      issueWithComments([{ id: '90002', author: { accountId: 'user-3' }, body: adf('hi') }]),
      'https://acme.atlassian.net',
      true,
    )[0]!
    expect(signal.permissions).toEqual({ visibility: 'restricted', scopeIds: ['jira:project:proj-1'] })
  })

  it('INT-8: an issue with no comments yields no comment signals', () => {
    expect(commentsFrom({ id: '1', key: 'ACME-7', fields: { summary: 'x' } }, 'https://acme.atlassian.net', false)).toEqual([])
  })

  it('INT-8: a comment signal names its author as a person', () => {
    const signal = commentsFrom(
      issueWithComments([
        { id: '90003', author: { accountId: 'user-3', displayName: 'Katherine Johnson', emailAddress: 'kj@acme.test' }, body: adf('hi') },
      ]),
      'https://acme.atlassian.net',
      false,
    )[0]!
    expect(candidatesFor(signal)).toEqual([
      {
        kind: 'person',
        externalId: 'jira:user:user-3',
        name: 'Katherine Johnson',
        aliases: ['kj@acme.test'],
        attributes: {},
        evidence: { signalExternalId: 'jira:comment:90003', source: 'jira' },
      },
    ])
  })
})
