import { describe, it, expect } from 'vitest'
import { RateLimitedError, UpstreamError } from '@chorus/core'
import { createJiraConnector } from '../../src/jira/index.js'
import { runSinkAction } from '../../src/sink-runner.js'
import { cassettePlayer } from '../../src/testing/cassettes.js'
import type { ConnectorContext } from '../../src/contract.js'

/**
 * INT-8 — the Jira sink, from cassettes.
 *
 * The source side (incremental pull, ADF→Markdown, entity mapping) is already
 * green. This drives the write side: create and update issues with a
 * Markdown→ADF body, and — Jira's own round-trip identity — stamp a `chorus`
 * issue property carrying the idempotency key so a create is idempotent (AC2)
 * and an issue Chorus made is recognised through the property even after its
 * local `external_links` mapping is lost (AC6). A create therefore searches by
 * the property before writing, and a retry whose first response was lost
 * resolves to the one issue rather than making a second.
 *
 * Cassettes are hand-authored from Jira's published REST shapes; nobody has run
 * this against a live site. Jira is REST, so each request is identified by its
 * method and full URL, which the player matches exactly and consumes in order.
 */

const frozen = new Date('2026-09-02T12:00:00.000Z')

function context(cassette: string): ConnectorContext {
  return {
    workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    integrationId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
    credentials: { accessToken: 'jira_access' },
    config: { siteUrl: 'https://acme.atlassian.net', projectKey: 'ACME' },
    now: () => frozen,
    fetch: cassettePlayer(cassette),
    saveCredentials: async () => {},
  }
}

const connectorFor = (cassette: string) =>
  createJiraConnector({ apiUrl: 'https://jira.test/api', fetch: cassettePlayer(cassette) })

describe('INT-8 Jira sink', () => {
  it('INT-8 AC1: declares the sink capability and external-write actions', () => {
    const connector = createJiraConnector()
    expect(connector.capabilities.sink).toBe(true)
    const actions = connector.sink?.actions ?? {}
    expect(Object.keys(actions).sort()).toEqual(['create_issue', 'update_issue'].sort())
    for (const action of Object.values(actions)) {
      expect(action.sideEffect).toBe('external')
    }
  })

  it('INT-8 AC2: creating an issue returns the created issue with its browse url', async () => {
    const connector = connectorFor('jira/sink-create.json')
    const action = connector.sink!.actions.create_issue!

    const ref = await runSinkAction(
      action,
      { projectKey: 'ACME', issueType: 'Task', summary: 'The deploy step times out', description: 'It **hangs** after the build.' },
      'idem-create-1',
      context('jira/sink-create.json'),
    )

    expect(ref.externalId).toBe('ACME-101')
    expect(ref.url).toBe('https://acme.atlassian.net/browse/ACME-101')
  })

  it('INT-8 AC3: the Markdown description is sent to Jira as an ADF document', async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = []
    const capturing = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = init?.body ? JSON.parse(init.body as string) : undefined
      requests.push({ method, url, body })
      if (url.includes('/search')) return new Response(JSON.stringify({ issues: [] }), { status: 200 })
      if (method === 'POST' && url.endsWith('/rest/api/3/issue'))
        return new Response(JSON.stringify({ id: '10101', key: 'ACME-101' }), { status: 201 })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    const connector = createJiraConnector({ apiUrl: 'https://jira.test/api', fetch: capturing })
    await runSinkAction(
      connector.sink!.actions.create_issue!,
      { projectKey: 'ACME', issueType: 'Task', summary: 'x', description: '**bold** and `code`' },
      'idem-adf-1',
      context('jira/sink-create.json'),
    )

    const post = requests.find((r) => r.method === 'POST' && r.url.endsWith('/rest/api/3/issue'))
    const fields = (post?.body as { fields?: { description?: { type?: string } } } | undefined)?.fields
    expect(fields?.description?.type).toBe('doc')
  })

  it('INT-8 AC6: a create whose response was lost is recovered through the chorus property, not duplicated', async () => {
    // The first create reached Jira and stamped its `chorus` property, but its
    // response was lost, so the caller never ran `find`. The retry goes through
    // the wrapper: `find` must discover the issue by the property rather than
    // make a second one.
    const connector = connectorFor('jira/sink-idempotent.json')
    const action = connector.sink!.actions.create_issue!
    const ctx = context('jira/sink-idempotent.json')

    const stranded = await action.execute(
      { projectKey: 'ACME', issueType: 'Task', summary: 'The deploy step times out' },
      'idem-lost-1',
      ctx,
    )
    const retried = await runSinkAction(
      action,
      { projectKey: 'ACME', issueType: 'Task', summary: 'The deploy step times out' },
      'idem-lost-1',
      ctx,
    )

    expect(retried.externalId).toBe(stranded.externalId)
  })

  it('INT-8 AC3: a rate limit is reported as retryable', async () => {
    const connector = connectorFor('jira/sink-rate-limited.json')
    const action = connector.sink!.actions.create_issue!

    const raised = await action
      .execute({ projectKey: 'ACME', issueType: 'Task', summary: 'x' }, 'idem-rate-1', context('jira/sink-rate-limited.json'))
      .then(() => undefined)
      .catch((error: unknown) => error)

    expect(raised, 'a rate limit must be retryable, not a permanent failure').toBeInstanceOf(
      RateLimitedError,
    )
  })

  it('INT-8 AC3: a validation failure fails immediately with an actionable message', async () => {
    const connector = connectorFor('jira/sink-invalid.json')
    const action = connector.sink!.actions.create_issue!

    const raised = await action
      .execute({ projectKey: 'ACME', issueType: 'Task', summary: '' }, 'idem-invalid-1', context('jira/sink-invalid.json'))
      .then(() => undefined)
      .catch((error: unknown) => error)

    // Permanent, not retryable: retrying a request Jira rejected as invalid just
    // fails again. The message has to say what was wrong.
    expect(raised).toBeInstanceOf(UpstreamError)
    expect(raised).not.toBeInstanceOf(RateLimitedError)
    expect((raised as UpstreamError).message).toMatch(/summary/i)
  })
})
