import { describe, it, expect } from 'vitest'
import { createConfluenceConnector } from '../../src/confluence/index.js'
import { runSinkAction } from '../../src/sink-runner.js'
import { cassettePlayer } from '../../src/testing/cassettes.js'
import type { ConnectorContext } from '../../src/contract.js'

/**
 * INT-9 AC5 — publishing a document updates the page in place.
 *
 * A Chorus document publishes to a Confluence page, and republishing — even
 * after the local mapping is lost — resolves the same page through its
 * `chorus-doc-id` content property and updates it, rather than making a second.
 * The property search is what makes recovery possible without a local row.
 */

const frozen = new Date('2026-09-02T12:00:00.000Z')

function context(cassette: string): ConnectorContext {
  return {
    workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    integrationId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
    credentials: { accessToken: 'conf-access' },
    config: { siteUrl: 'https://acme.atlassian.net' },
    now: () => frozen,
    fetch: cassettePlayer(cassette),
    saveCredentials: async () => {},
  }
}

const connectorFor = (cassette: string) =>
  createConfluenceConnector({ apiUrl: 'https://conf.test/api', fetch: cassettePlayer(cassette) })

describe('INT-9 Confluence sink (AC5)', () => {
  it('INT-9 AC5: the sink declares the capability and publish is an external write', () => {
    const connector = createConfluenceConnector()
    expect(connector.capabilities.sink).toBe(true)
    const publish = connector.sink?.actions.publish
    expect(publish?.sideEffect).toBe('external')
  })

  it('INT-9 AC5: publishing a new document creates a page', async () => {
    const connector = connectorFor('confluence/publish-create.json')
    const ref = await runSinkAction(
      connector.sink!.actions.publish!,
      { spaceKey: 'ENG', title: 'Deploy runbook', body: '# Deploy\n\nRaise the timeout.', docId: 'doc-abc' },
      'idem-pub-1',
      context('confluence/publish-create.json'),
    )
    expect(ref.externalId).toBe('55501')
    expect(ref.url).toBe('https://acme.atlassian.net/wiki/spaces/ENG/pages/55501/Deploy+runbook')
  })

  it('INT-9: a header banner linking back to Chorus is prepended to the published body', async () => {
    let posted: { body?: { atlas_doc_format?: { value?: string } } } | undefined
    const capturing = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = String(url)
      if (u.includes('/content/search')) return new Response(JSON.stringify({ results: [] }), { status: 200 })
      if ((init?.method ?? 'GET') === 'POST' && u.endsWith('/wiki/rest/api/content')) {
        posted = JSON.parse(init!.body as string) as typeof posted
        return new Response(JSON.stringify({ id: '55501', _links: { webui: '/x' } }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch

    const connector = createConfluenceConnector({ apiUrl: 'https://conf.test/api', fetch: capturing })
    await connector.sink!.actions.publish!.execute(
      { spaceKey: 'ENG', title: 'Runbook', body: 'Body text.', docId: 'doc-xyz', chorusUrl: 'https://chorus.test/d/doc-xyz' },
      'idem-banner',
      { ...context('confluence/publish-create.json'), fetch: capturing },
    )
    expect(posted?.body?.atlas_doc_format?.value).toContain('https://chorus.test/d/doc-xyz')
  })

  it('INT-9 AC5: republishing updates the same page, resolved through the chorus-doc-id property', async () => {
    const connector = connectorFor('confluence/publish-update.json')
    const ref = await runSinkAction(
      connector.sink!.actions.publish!,
      { spaceKey: 'ENG', title: 'Deploy runbook (v2)', body: '# Deploy\n\nRaise it further.', docId: 'doc-abc' },
      'idem-pub-2',
      context('confluence/publish-update.json'),
    )
    // The same page id, not a new one.
    expect(ref.externalId).toBe('55501')
  })
})
