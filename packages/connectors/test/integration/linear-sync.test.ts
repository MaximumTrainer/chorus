import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHmac, randomBytes } from 'node:crypto'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createKeyring, parseMasterKey, ulid, type Signal } from '@chorus/core'
import { createCredentialStore, type CredentialStore } from '../../src/credentials.js'
import { createSyncRunner } from '../../src/sync.js'
import { createWebhookReceiver } from '../../src/webhooks.js'
import { createLinearConnector } from '../../src/linear/index.js'
import { cassettePlayer } from '../../src/testing/cassettes.js'

/**
 * INT-2 AC5 — Linear issues round-trip as signals and deterministic entities.
 *
 * Two halves, and the second is the one worth a test of its own: the
 * deterministic pass has to be *deterministic*, and it has to be complete
 * enough that a person mentioned only as an assignee still becomes a person.
 * A pass that produced entities but varied their ids would grow one entity per
 * mention, and nothing downstream would notice until the brain was full of
 * near-duplicates.
 */
describe('INT-2 Linear connector', () => {
  let db: IsolatedDatabase
  let store: CredentialStore
  const master = parseMasterKey('k1', randomBytes(32).toString('base64'))
  const frozen = new Date('2026-09-02T12:00:00.000Z')
  const SECRET = 'linear-webhook-secret'

  async function connected(): Promise<{ workspaceId: string; integrationId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM integrations WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM workspace_data_keys WHERE workspace_id = $1`, [workspaceId])
    const integration = await store.connect({
      workspaceId,
      kind: 'linear',
      credentials: {
        accessToken: 'lin_oauth_original',
        refreshToken: 'refresh-original',
        webhookSecret: SECRET,
      },
      config: { organisation: 'acme' },
    })
    return { workspaceId, integrationId: integration.id }
  }

  const signalsIn = (workspaceId: string) =>
    db.admin.query<{
      external_id: string
      kind: string
      text: string | null
      permissions: { visibility: string; scopeIds: string[] }
      structured: Record<string, unknown>
      raw: Record<string, unknown>
    }>(
      `SELECT external_id, kind, text, permissions, structured, raw
         FROM signals WHERE workspace_id = $1 ORDER BY external_id`,
      [workspaceId],
    )

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    store = createCredentialStore(db.config, createKeyring([master]), master)
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('INT-2 AC5: issues, comments, projects and cycles all arrive as signals', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    const outcome = await runner.sync(
      workspaceId,
      integrationId,
      createLinearConnector({ fetch: cassettePlayer('linear/pull.json') }),
    )

    expect(outcome.state).toBe('caught_up')
    expect(new Set((await signalsIn(workspaceId)).map((row) => row.kind))).toEqual(
      new Set(['issue', 'issue_comment', 'project', 'cycle']),
    )
  })

  it('INT-2 AC5: an issue is identified by the code people actually use', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })
    await runner.sync(
      workspaceId,
      integrationId,
      createLinearConnector({ fetch: cassettePlayer('linear/pull.json') }),
    )

    // `ACME-7`, not a UUID. An external id nobody can match against what they
    // are looking at is one nobody trusts when it turns up in a citation.
    const issue = (await signalsIn(workspaceId)).find((row) => row.kind === 'issue')!
    expect(issue.external_id).toBe('linear:issue:ACME-7')
    expect(issue.structured).toMatchObject({ state: 'Todo', team: 'ACME', cycle: 4 })
  })

  it('INT-2 AC5: an issue yields a Ticket and every person it names', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })
    const connector = createLinearConnector({ fetch: cassettePlayer('linear/pull.json') })
    await runner.sync(workspaceId, integrationId, connector)

    const issue = (await signalsIn(workspaceId)).find((row) => row.kind === 'issue')!
    const candidates = connector.mapExternal!({
      ...(issue as unknown as Signal),
      source: 'linear',
      raw: issue.raw,
      externalId: issue.external_id,
      kind: 'issue',
      url: null,
    } as Signal)

    const ticket = candidates.find((candidate) => candidate.kind === 'ticket')!
    expect(ticket.name).toBe('The deploy step times out')
    // The short code has to resolve as an alias, or every conversational
    // mention of ACME-7 becomes a new entity.
    expect(ticket.aliases).toContain('ACME-7')
    expect(ticket.evidence).toEqual({ signalExternalId: 'linear:issue:ACME-7', source: 'linear' })

    // Creator *and* assignee. A pass that read only the creator would leave
    // half the workspace's people undiscovered.
    const people = candidates.filter((candidate) => candidate.kind === 'person')
    expect(people.map((person) => person.externalId).sort()).toEqual([
      'linear:user:user-501',
      'linear:user:user-502',
    ])
    expect(people.find((p) => p.externalId === 'linear:user:user-501')!.aliases).toContain('ada')
  })

  it('INT-2 AC5: a project yields a Feature, and a cycle yields no entity of its own', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })
    const connector = createLinearConnector({ fetch: cassettePlayer('linear/pull.json') })
    await runner.sync(workspaceId, integrationId, connector)

    const rows = await signalsIn(workspaceId)
    const project = rows.find((row) => row.kind === 'project')!
    const asSignal = (row: (typeof rows)[number], kind: string): Signal =>
      ({ source: 'linear', externalId: row.external_id, kind, raw: row.raw, url: null }) as Signal

    const fromProject = connector.mapExternal!(asSignal(project, 'project'))
    expect(fromProject.find((c) => c.kind === 'feature')!.name).toBe('Reliability')

    // A cycle is a time box, not a thing the brain reasons about. Producing an
    // entity for it would add noise nothing queries.
    const cycle = rows.find((row) => row.kind === 'cycle')!
    expect(connector.mapExternal!(asSignal(cycle, 'cycle'))).toHaveLength(0)
  })

  it('INT-2 AC7: Linear signals are restricted, because a tracker is not public', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })
    await runner.sync(
      workspaceId,
      integrationId,
      createLinearConnector({ fetch: cassettePlayer('linear/pull.json') }),
    )

    for (const row of await signalsIn(workspaceId)) {
      expect(row.permissions.visibility).toBe('restricted')
      expect(row.permissions.scopeIds).toEqual(['linear:organisation'])
    }
  })

  it('INT-2: a GraphQL error is a failure, not an empty page', async () => {
    // GraphQL answers 200 with an `errors` array. A connector that checked only
    // the status would treat a failed query as "no data" — a sync that ingests
    // nothing and reports success.
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    const failing: typeof fetch = async () =>
      new Response(JSON.stringify({ errors: [{ message: 'Field does not exist' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    const outcome = await runner.sync(
      workspaceId,
      integrationId,
      createLinearConnector({ fetch: failing }),
    )

    expect(outcome.state).toBe('failed')
    expect(outcome.error).toMatch(/Field does not exist/)
    expect(await signalsIn(workspaceId)).toHaveLength(0)
  })

  it('INT-2: a webhook delivery id is derived, and distinguishes two events on one object', async () => {
    const { workspaceId, integrationId } = await connected()
    const receiver = createWebhookReceiver(db.config, store, { now: () => frozen })

    const send = (action: string, timestamp: number, title: string) => {
      const body = JSON.stringify({
        action,
        type: 'Issue',
        webhookId: 'wh-1',
        webhookTimestamp: timestamp,
        data: {
          id: 'lin-issue-1',
          identifier: 'ACME-7',
          title,
          url: 'https://linear.app/acme/issue/ACME-7',
          createdAt: '2026-09-01T09:00:00.000Z',
          updatedAt: '2026-09-01T09:00:00.000Z',
          state: { name: 'Todo', type: 'unstarted' },
          creator: { id: 'user-501', name: 'Ada Lovelace', displayName: 'ada' },
        },
      })
      return receiver.receive(workspaceId, integrationId, createLinearConnector(), {
        headers: {
          'linear-signature': createHmac('sha256', SECRET).update(body).digest('hex'),
          'linear-event': 'Issue',
        },
        body,
      })
    }

    // Linear's `webhookId` names the *subscription*, not the delivery. Using it
    // would collapse these two into one and discard the second as a duplicate.
    const created = await send('create', 1788000000000, 'The deploy step times out')
    const updated = await send('update', 1788000060000, 'The deploy step times out (again)')

    expect(created.state).toBe('processed')
    expect(updated.state).toBe('processed')
    expect(created.deliveryId).not.toBe(updated.deliveryId)

    // Both describe the same issue, so they deduplicate to one signal — which
    // is correct, and different from the deliveries being deduplicated.
    expect(await signalsIn(workspaceId)).toHaveLength(1)
  })

  it('INT-2: the same delivery twice is still one delivery', async () => {
    const { workspaceId, integrationId } = await connected()
    const receiver = createWebhookReceiver(db.config, store, { now: () => frozen })

    const body = JSON.stringify({
      action: 'create',
      type: 'Issue',
      webhookId: 'wh-1',
      webhookTimestamp: 1788000000000,
      data: {
        id: 'lin-issue-2',
        identifier: 'ACME-8',
        title: 'Retry storm on deploy',
        url: 'https://linear.app/acme/issue/ACME-8',
        createdAt: '2026-09-01T09:00:00.000Z',
        updatedAt: '2026-09-01T09:00:00.000Z',
        creator: { id: 'user-501', name: 'Ada Lovelace', displayName: 'ada' },
      },
    })
    const event = {
      headers: {
        'linear-signature': createHmac('sha256', SECRET).update(body).digest('hex'),
        'linear-event': 'Issue',
      },
      body,
    }

    expect((await receiver.receive(workspaceId, integrationId, createLinearConnector(), event)).state).toBe(
      'processed',
    )
    expect((await receiver.receive(workspaceId, integrationId, createLinearConnector(), event)).state).toBe(
      'duplicate',
    )
  })

  it('INT-2: a refreshed Linear token is persisted, rotation included', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    await runner.sync(
      workspaceId,
      integrationId,
      createLinearConnector({
        fetch: cassettePlayer('linear/refresh.json'),
        clientId: 'chorus-linear-app',
        clientSecret: 'chorus-linear-secret',
      }),
    )

    const stored = await store.credentialsFor(workspaceId, integrationId)
    expect(stored.accessToken).toBe('lin_oauth_refreshed')
    expect(stored.refreshToken).toBe('refresh-rotated')
    expect(stored.webhookSecret).toBe(SECRET)
  })
})
