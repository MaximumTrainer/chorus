import { createHmac } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { createJiraConnector } from '../../src/jira/index.js'
import { cassettePlayer } from '../../src/testing/cassettes.js'
import type { ConnectorContext, WebhookRequest } from '../../src/contract.js'

/**
 * INT-8 AC2 — incremental pull and webhooks agree.
 *
 * The one guarantee that matters: a change that arrives by webhook and the same
 * change picked up by the JQL cursor sync must carry the *same* signal identity,
 * because deduplication is by `(integration_id, external_id, kind)`. If the two
 * paths minted different ids, an issue changed while webhooks were down and then
 * seen again by both paths would be ingested twice. Both paths run the same
 * issue through `issueToSignal`, so they resolve to one `jira:issue:<key>`.
 *
 * Webhook bodies are hand-authored from Jira Cloud's published shapes; nobody
 * has run this against a live site.
 */

const frozen = new Date('2026-09-02T12:00:00.000Z')

function context(cassette?: string): ConnectorContext {
  return {
    workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    integrationId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
    credentials: { accessToken: 'jira_access', webhookSecret: 'jira_hook_secret' },
    config: { siteUrl: 'https://acme.atlassian.net', privateByDefault: true },
    now: () => frozen,
    fetch: cassette ? cassettePlayer(cassette) : (async () => new Response(null)) as unknown as typeof fetch,
    saveCredentials: async () => {},
  }
}

const issueBody = (event: string) =>
  JSON.stringify({
    timestamp: 1_756_717_800_000,
    webhookEvent: event,
    issue: {
      id: '10001',
      key: 'ACME-7',
      fields: {
        summary: 'The deploy step times out',
        description: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'It hangs after the build.' }] }],
        },
        status: { name: 'In Progress' },
        issuetype: { name: 'Bug', subtask: false },
        assignee: { accountId: 'user-1', displayName: 'Ada Lovelace', emailAddress: 'ada@acme.test' },
        reporter: { accountId: 'user-2', displayName: 'Grace Hopper' },
        project: { key: 'ACME', id: 'proj-1' },
        updated: '2026-09-02T11:00:00.000+0000',
      },
    },
  })

const signed = (body: string, secret = 'jira_hook_secret'): WebhookRequest => ({
  headers: { 'x-hub-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
  body,
})

describe('INT-8 Jira webhooks', () => {
  it('INT-8 AC2: a webhook delivery and the JQL pull yield the same signal identity for one issue', async () => {
    const connector = createJiraConnector({ apiUrl: 'https://jira.test/api', fetch: cassettePlayer('jira/pull.json') })

    const pulled = await connector.pull!(null, context('jira/pull.json'))
    const delivered = await connector.handleWebhook!(signed(issueBody('jira:issue_updated')), context())

    expect(pulled.signals[0]?.externalId).toBe('jira:issue:ACME-7')
    expect(delivered[0]?.externalId).toBe(pulled.signals[0]?.externalId)
  })

  it('INT-8 AC2: created and updated events both yield an issue signal', async () => {
    const connector = createJiraConnector()
    const created = await connector.handleWebhook!(signed(issueBody('jira:issue_created')), context())
    const updated = await connector.handleWebhook!(signed(issueBody('jira:issue_updated')), context())

    expect(created[0]?.externalId).toBe('jira:issue:ACME-7')
    expect(updated[0]?.externalId).toBe('jira:issue:ACME-7')
  })

  it('INT-8 AC2: an event carrying no issue yields nothing to ingest', async () => {
    const connector = createJiraConnector()
    const body = JSON.stringify({ timestamp: 1, webhookEvent: 'jira:worklog_updated' })
    const signals = await connector.handleWebhook!(signed(body), context())
    expect(signals).toEqual([])
  })

  it('INT-8 AC2: the delivery id is stable across a redelivery of the same event', () => {
    const connector = createJiraConnector()
    const request = signed(issueBody('jira:issue_updated'))
    const first = connector.webhooks!.deliveryId(request)
    const again = connector.webhooks!.deliveryId(signed(issueBody('jira:issue_updated')))
    expect(first).toBeTruthy()
    expect(again).toBe(first)
  })

  it('INT-8 AC2: a tampered body fails signature verification', () => {
    const connector = createJiraConnector()
    const request = signed(issueBody('jira:issue_updated'))
    expect(connector.webhooks!.verify(request, 'jira_hook_secret')).toBe(true)
    expect(connector.webhooks!.verify({ ...request, body: `${request.body} ` }, 'jira_hook_secret')).toBe(false)
  })
})
