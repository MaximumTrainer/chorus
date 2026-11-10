import { describe, it, expect } from 'vitest'
import { candidatesFor, pageToSignal, type ConfluencePage } from './streams.js'

/**
 * INT-9 — mapping a Confluence page to a Signal and its deterministic entities.
 *
 * A page is a Page entity; its space is a topic container for brain-map
 * grouping; its author is a Person. The body is ADF (ADR-0022), carried as a
 * stringified document, converted to Markdown with its macros resolved.
 */

const adfString = JSON.stringify({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Raise the timeout to fix the deploy.' }] }],
})

function page(overrides: Partial<ConfluencePage> = {}): ConfluencePage {
  return {
    id: '12345',
    type: 'page',
    title: 'Deploy runbook',
    space: { id: 98, key: 'ENG', name: 'Engineering' },
    history: { createdBy: { accountId: 'u1', displayName: 'Ada Lovelace' } },
    version: { number: 3, when: '2026-09-01T10:00:00.000Z', by: { accountId: 'u2', displayName: 'Grace Hopper' } },
    body: { atlas_doc_format: { value: adfString } },
    _links: { webui: '/spaces/ENG/pages/12345/Deploy+runbook' },
    ...overrides,
  }
}

describe('INT-9 Confluence page mapping', () => {
  it('INT-9: a page becomes an authored signal with its body in Markdown', () => {
    const signal = pageToSignal(page(), 'https://acme.atlassian.net', false)
    expect(signal).toMatchObject({
      source: 'confluence',
      externalId: 'confluence:page:12345',
      kind: 'page',
      text: 'Raise the timeout to fix the deploy.',
      author: { externalId: 'u2', display: 'Grace Hopper' },
    })
    expect(signal.url).toBe('https://acme.atlassian.net/wiki/spaces/ENG/pages/12345/Deploy+runbook')
    expect(signal.occurredAt).toEqual(new Date('2026-09-01T10:00:00.000Z'))
  })

  it('INT-9: a blog post keeps its own kind', () => {
    expect(pageToSignal(page({ type: 'blogpost' }), 'https://acme.atlassian.net', false).kind).toBe('blogpost')
  })

  it('INT-9: a restricted page is scoped to its space', () => {
    expect(pageToSignal(page(), 'https://acme.atlassian.net', true).permissions).toEqual({
      visibility: 'restricted',
      scopeIds: ['confluence:space:98'],
    })
  })

  it('INT-9: a malformed body does not throw; the title stands in', () => {
    const signal = pageToSignal(page({ body: { atlas_doc_format: { value: 'not json' } } }), 'https://acme.atlassian.net', false)
    expect(signal.text).toBe('Deploy runbook')
  })

  it('INT-9: a page yields a Page entity, its space a topic, and its author a person', () => {
    const signal = pageToSignal(page(), 'https://acme.atlassian.net', false)
    const kinds = candidatesFor(signal).map((c) => `${c.kind}:${c.externalId}`).sort()
    expect(kinds).toEqual(
      ['page:confluence:page:12345', 'person:confluence:user:u2', 'topic:confluence:space:ENG'].sort(),
    )
  })

  it('INT-9: the Page entity carries its space and url', () => {
    const signal = pageToSignal(page(), 'https://acme.atlassian.net', false)
    const pageEntity = candidatesFor(signal).find((c) => c.kind === 'page')
    expect(pageEntity?.attributes).toMatchObject({ space: 'ENG', url: signal.url })
  })
})
