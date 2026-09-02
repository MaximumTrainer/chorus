import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHmac, randomBytes } from 'node:crypto'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createKeyring, parseMasterKey, ulid } from '@chorus/core'
import { createCredentialStore, type CredentialStore } from '../../src/credentials.js'
import { createWebhookReceiver, type WebhookReceiver } from '../../src/webhooks.js'
import { createReferenceConnector } from '../../src/reference/index.js'

/**
 * INT-1 AC3 — webhook receipt, verification, deduplication and replay.
 *
 * A webhook endpoint is the one part of the system an unauthenticated stranger
 * can reach on purpose, and the one place a source will cheerfully deliver the
 * same event three times. So the three properties are tested together, against
 * a real database, because they interact: a receiver that verifies but does not
 * deduplicate is a duplicate-effect bug, and one that deduplicates before
 * verifying lets a forgery poison the dedup key so the genuine delivery is
 * later discarded as a repeat.
 *
 * Replay is here for the reason the implementation notes give: it is the only
 * practical way to debug a connector against a source you cannot reproduce.
 */
describe('INT-1 webhook receiver', () => {
  let db: IsolatedDatabase
  let store: CredentialStore
  let receiver: WebhookReceiver
  const master = parseMasterKey('k1', randomBytes(32).toString('base64'))
  const frozen = new Date('2026-09-02T12:00:00.000Z')
  const SECRET = 'a-shared-webhook-secret'

  async function connected(): Promise<{ workspaceId: string; integrationId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM integrations WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM workspace_data_keys WHERE workspace_id = $1`, [workspaceId])
    const integration = await store.connect({
      workspaceId,
      kind: 'reference',
      credentials: { webhookSecret: SECRET },
    })
    return { workspaceId, integrationId: integration.id }
  }

  /** A delivery signed the way the reference connector expects. */
  function delivery(deliveryId: string, body: unknown, secret = SECRET) {
    const raw = JSON.stringify(body)
    return {
      headers: {
        'x-reference-delivery': deliveryId,
        'x-reference-signature': createHmac('sha256', secret).update(raw).digest('hex'),
      },
      body: raw,
    }
  }

  const signalsIn = (workspaceId: string) =>
    db.admin.query<{ external_id: string }>(
      `SELECT external_id FROM signals WHERE workspace_id = $1 ORDER BY external_id`,
      [workspaceId],
    )

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    store = createCredentialStore(db.config, createKeyring([master]), master)
    receiver = createWebhookReceiver(db.config, store, { now: () => frozen })
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('INT-1 AC3: a valid delivery is processed, and its signals are stored', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector()

    const outcome = await receiver.receive(
      workspaceId,
      integrationId,
      connector,
      delivery('d-1', { id: 'hook-1', text: 'something happened', at: '2026-09-01T09:00:00.000Z' }),
    )

    expect(outcome.state).toBe('processed')
    expect(outcome.ingested).toBe(1)
    expect((await signalsIn(workspaceId)).map((r) => r.external_id)).toEqual(['hook-1'])
  })

  it('INT-1 AC3: a forged delivery is refused, and produces no signals', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector()

    const outcome = await receiver.receive(
      workspaceId,
      integrationId,
      connector,
      delivery('d-forged', { id: 'hook-evil', text: 'trust me' }, 'the-wrong-secret'),
    )

    expect(outcome.state).toBe('rejected')
    expect(await signalsIn(workspaceId)).toHaveLength(0)

    // Recorded, so an attempt is visible rather than silently dropped.
    const [row] = await db.admin.query<{ signature_ok: boolean; processed_at: Date | null }>(
      `SELECT signature_ok, processed_at FROM webhook_deliveries WHERE delivery_id = 'd-forged'`,
      [],
    )
    expect(row!.signature_ok).toBe(false)
    expect(row!.processed_at, 'a forged delivery must never be marked processed').toBeNull()
  })

  it('INT-1 AC3: the same delivery arriving twice is deduplicated by delivery id', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector()
    const event = delivery('d-2', { id: 'hook-2', text: 'at most once', at: '2026-09-01T09:00:00.000Z' })

    const first = await receiver.receive(workspaceId, integrationId, connector, event)
    const second = await receiver.receive(workspaceId, integrationId, connector, event)

    expect(first.state).toBe('processed')
    expect(second.state).toBe('duplicate')
    expect(second.ingested).toBe(0)
    expect(await signalsIn(workspaceId)).toHaveLength(1)

    const rows = await db.admin.query(
      `SELECT 1 FROM webhook_deliveries WHERE integration_id = $1 AND delivery_id = 'd-2'`,
      [integrationId],
    )
    expect(rows, 'a repeat must not create a second delivery row').toHaveLength(1)
  })

  it('INT-1 AC3: a forgery cannot poison the dedup key and suppress the genuine delivery', async () => {
    // The ordering trap: deduplicate before verifying, and an attacker who
    // guesses a delivery id gets the real event discarded as a repeat.
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector()

    const forged = await receiver.receive(
      workspaceId,
      integrationId,
      connector,
      delivery('d-3', { id: 'hook-evil', text: 'first!' }, 'the-wrong-secret'),
    )
    expect(forged.state).toBe('rejected')

    const genuine = await receiver.receive(
      workspaceId,
      integrationId,
      connector,
      delivery('d-3', { id: 'hook-3', text: 'the real one', at: '2026-09-01T09:00:00.000Z' }),
    )

    expect(genuine.state, 'the genuine delivery must still be processed').toBe('processed')
    expect((await signalsIn(workspaceId)).map((r) => r.external_id)).toEqual(['hook-3'])
  })

  it('INT-1 AC3: a stored delivery can be replayed without duplicating its effects', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector()
    await receiver.receive(
      workspaceId,
      integrationId,
      connector,
      delivery('d-4', { id: 'hook-4', text: 'replay me', at: '2026-09-01T09:00:00.000Z' }),
    )

    const replayed = await receiver.replay(workspaceId, integrationId, connector, 'd-4')

    expect(replayed.state).toBe('processed')
    expect(replayed.ingested, 'a replay must ingest nothing new').toBe(0)
    expect(await signalsIn(workspaceId)).toHaveLength(1)
  })

  it('INT-1 AC3: a replay re-runs the connector, which is what makes it useful for debugging', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector()
    await receiver.receive(
      workspaceId,
      integrationId,
      connector,
      delivery('d-5', { id: 'hook-5', text: 'original', at: '2026-09-01T09:00:00.000Z' }),
    )

    // A replay that returned the stored result would prove nothing about the
    // connector — the whole point is to run today's mapping code over
    // yesterday's payload.
    let handled = 0
    const original = connector.handleWebhook!.bind(connector)
    connector.handleWebhook = async (request, ctx) => {
      handled += 1
      return original(request, ctx)
    }

    await receiver.replay(workspaceId, integrationId, connector, 'd-5')
    expect(handled).toBe(1)
  })

  it('INT-1 AC3: a forged delivery cannot be replayed', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector()
    await receiver.receive(
      workspaceId,
      integrationId,
      connector,
      delivery('d-6', { id: 'hook-6', text: 'nope', at: '2026-09-01T09:00:00.000Z' }, 'the-wrong-secret'),
    )

    // Replay would otherwise be a way to get an unverified payload executed
    // later, by whoever can reach the debugging endpoint.
    await expect(
      receiver.replay(workspaceId, integrationId, connector, 'd-6'),
    ).rejects.toThrow(/signature|verif/i)
  })

  it('INT-1 AC3: replaying an unknown delivery is a not-found, not a silent success', async () => {
    const { workspaceId, integrationId } = await connected()
    await expect(
      receiver.replay(workspaceId, integrationId, createReferenceConnector(), 'never-existed'),
    ).rejects.toThrow(/No such delivery/)
  })

  it('INT-1 AC3: a delivery with no delivery id is refused, because it cannot be deduplicated', async () => {
    const { workspaceId, integrationId } = await connected()
    const raw = JSON.stringify({ id: 'hook-7', text: 'anonymous', at: '2026-09-01T09:00:00.000Z' })

    const outcome = await receiver.receive(workspaceId, integrationId, createReferenceConnector(), {
      headers: { 'x-reference-signature': createHmac('sha256', SECRET).update(raw).digest('hex') },
      body: raw,
    })

    // Accepting it would mean at-least-once delivery with no way to collapse
    // the repeats — which is worse than refusing, because it is invisible.
    expect(outcome.state).toBe('rejected')
    expect(await signalsIn(workspaceId)).toHaveLength(0)
  })

  it('INT-1 AC3: the raw body is stored, so a replay verifies against what actually arrived', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector()
    // Key order and whitespace change an HMAC. Re-serialising a parsed body
    // before verifying is the classic way a webhook receiver rejects genuine
    // deliveries in production and nowhere else.
    const raw = '{"text":"order matters",  "id":"hook-8", "at":"2026-09-01T09:00:00.000Z"}'
    const event = {
      headers: {
        'x-reference-delivery': 'd-8',
        'x-reference-signature': createHmac('sha256', SECRET).update(raw).digest('hex'),
      },
      body: raw,
    }

    expect((await receiver.receive(workspaceId, integrationId, connector, event)).state).toBe(
      'processed',
    )
    expect((await receiver.replay(workspaceId, integrationId, connector, 'd-8')).state).toBe(
      'processed',
    )
  })

  it('INT-1 AC3: a connector that throws records the error against the delivery', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector()
    connector.handleWebhook = async () => {
      throw new Error('could not map that payload')
    }

    const outcome = await receiver.receive(
      workspaceId,
      integrationId,
      connector,
      delivery('d-9', { id: 'hook-9', text: 'unmappable', at: '2026-09-01T09:00:00.000Z' }),
    )

    expect(outcome.state).toBe('failed')
    const [row] = await db.admin.query<{ error: string; processed_at: Date | null }>(
      `SELECT error, processed_at FROM webhook_deliveries WHERE delivery_id = 'd-9'`,
    )
    expect(row!.error).toMatch(/could not map/)
    // Unprocessed, so a retry or a replay will attempt it again rather than
    // treating a failure as a completed delivery.
    expect(row!.processed_at).toBeNull()
  })

  it('INT-1 AC3: a failed delivery can be retried once the mapping is fixed', async () => {
    const { workspaceId, integrationId } = await connected()
    const broken = createReferenceConnector()
    broken.handleWebhook = async () => {
      throw new Error('could not map that payload')
    }
    await receiver.receive(
      workspaceId,
      integrationId,
      broken,
      delivery('d-10', { id: 'hook-10', text: 'fix me', at: '2026-09-01T09:00:00.000Z' }),
    )

    // This is what replay is for: yesterday's payload, today's code.
    const fixed = await receiver.replay(
      workspaceId,
      integrationId,
      createReferenceConnector(),
      'd-10',
    )

    expect(fixed.state).toBe('processed')
    expect((await signalsIn(workspaceId)).map((r) => r.external_id)).toEqual(['hook-10'])
  })

  it("INT-1: a delivery is confined to its own workspace", async () => {
    const mine = await connected()
    const theirs = await connected()
    await receiver.receive(
      mine.workspaceId,
      mine.integrationId,
      createReferenceConnector(),
      delivery('d-11', { id: 'hook-11', text: 'mine', at: '2026-09-01T09:00:00.000Z' }),
    )

    await expect(
      receiver.replay(
        theirs.workspaceId,
        theirs.integrationId,
        createReferenceConnector(),
        'd-11',
      ),
    ).rejects.toThrow(/No such delivery/)
    expect(await signalsIn(theirs.workspaceId)).toHaveLength(0)
  })

  it('INT-1 AC3: the stored delivery never contains the signing secret', async () => {
    const { workspaceId, integrationId } = await connected()
    await receiver.receive(
      workspaceId,
      integrationId,
      createReferenceConnector(),
      delivery('d-12', { id: 'hook-12', text: 'safe', at: '2026-09-01T09:00:00.000Z' }),
    )

    const [row] = await db.admin.query<Record<string, unknown>>(
      `SELECT * FROM webhook_deliveries WHERE delivery_id = 'd-12'`,
    )
    expect(JSON.stringify(row)).not.toContain(SECRET)
  })
})
