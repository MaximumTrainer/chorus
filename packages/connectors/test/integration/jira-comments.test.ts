import { createHmac } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { createJiraConnector } from '../../src/jira/index.js'
import { cassettePlayer } from '../../src/testing/cassettes.js'
import type { ConnectorContext, WebhookRequest } from '../../src/contract.js'

/**
 * INT-8 — Jira comments as a source stream.
 *
 * Comments ride the issue's page in the pull and arrive live by webhook, and
 * both paths run the same `commentsFrom`, so a comment seen by both resolves to
 * one `jira:comment:<id>` and dedupes like the issue does (AC2).
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

const commentBody = JSON.stringify({
  timestamp: 1_756_717_800_000,
  webhookEvent: 'comment_created',
  issue: { id: '10001', key: 'ACME-7', fields: { project: { key: 'ACME', id: 'proj-1' } } },
  comment: {
    id: '90001',
    author: { accountId: 'user-3', displayName: 'Katherine Johnson' },
    body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Raising the timeout fixed it locally.' }] }] },
    created: '2026-09-01T10:00:00.000+0000',
    updated: '2026-09-01T10:00:00.000+0000',
  },
})

const signed = (body: string, secret = 'jira_hook_secret'): WebhookRequest => ({
  headers: { 'x-hub-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
  body,
})

describe('INT-8 Jira comments', () => {
  it('INT-8: the pull emits an authored comment signal alongside its issue', async () => {
    const connector = createJiraConnector({ apiUrl: 'https://jira.test/api', fetch: cassettePlayer('jira/pull.json') })
    const { signals } = await connector.pull!(null, context('jira/pull.json'))

    const comment = signals.find((s) => s.kind === 'comment')
    expect(comment?.externalId).toBe('jira:comment:90001')
    expect(comment?.text).toBe('Raising the timeout fixed it locally.')
    expect(comment?.author).toEqual({ externalId: 'user-3', display: 'Katherine Johnson' })
  })

  it('INT-8 AC2: a comment webhook and the pull yield the same comment identity', async () => {
    const connector = createJiraConnector({ apiUrl: 'https://jira.test/api', fetch: cassettePlayer('jira/pull.json') })
    const { signals } = await connector.pull!(null, context('jira/pull.json'))
    const pulledComment = signals.find((s) => s.kind === 'comment')

    const delivered = await connector.handleWebhook!(signed(commentBody), context())
    expect(delivered[0]?.kind).toBe('comment')
    expect(delivered[0]?.externalId).toBe(pulledComment?.externalId)
  })

  it('INT-8: a comment signal names its commenter as a person', async () => {
    const connector = createJiraConnector({ apiUrl: 'https://jira.test/api', fetch: cassettePlayer('jira/pull.json') })
    const { signals } = await connector.pull!(null, context('jira/pull.json'))
    const comment = signals.find((s) => s.kind === 'comment')!

    const candidates = connector.mapExternal!(comment)
    expect(candidates).toEqual([
      expect.objectContaining({ kind: 'person', externalId: 'jira:user:user-3' }),
    ])
  })
})
