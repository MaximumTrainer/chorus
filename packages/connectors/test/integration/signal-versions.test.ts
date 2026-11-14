import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHmac, randomBytes } from 'node:crypto'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createKeyring, parseMasterKey, ulid } from '@chorus/core'
import { createCredentialStore, type CredentialStore } from '../../src/credentials.js'
import { createSyncRunner, type SyncRunner } from '../../src/sync.js'
import { createWebhookReceiver, type WebhookReceiver } from '../../src/webhooks.js'
import { createReferenceConnector } from '../../src/reference/index.js'

/**
 * BRAIN-1 AC3 — signals are append-only; supersession is a relationship.
 *
 * A source item whose content changes is stored as a *new* signal that names
 * the one it supersedes; the original row is never updated. Until now the
 * uniqueness index refused the edited item outright, so the change was simply
 * lost. Unchanged content is still not stored twice (AC2), a revert to earlier
 * content is a new version rather than a no-op, and a change to who may see an
 * item is a change like any other — the new scope must be what applies.
 */
describe('BRAIN-1 signal versions (AC3)', () => {
  let db: IsolatedDatabase
  let store: CredentialStore
  let runner: SyncRunner
  let receiver: WebhookReceiver
  const master = parseMasterKey('k1', randomBytes(32).toString('base64'))
  const frozen = new Date('2026-11-14T12:00:00.000Z')
  const SECRET = 'a-shared-webhook-secret'

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    store = createCredentialStore(db.config, createKeyring([master]), master)
    runner = createSyncRunner(db.config, store, { now: () => frozen })
    receiver = createWebhookReceiver(db.config, store, { now: () => frozen })
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  async function connected(): Promise<{ workspaceId: string; integrationId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    for (const table of ['signals', 'integrations', 'workspace_data_keys']) {
      await db.admin.execute(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId])
    }
    const integration = await store.connect({
      workspaceId,
      kind: 'reference',
      credentials: { token: 'ref', webhookSecret: SECRET },
    })
    return { workspaceId, integrationId: integration.id }
  }

  const versions = (workspaceId: string, externalId: string) =>
    db.admin.query<{ id: string; text: string; supersedes_id: string | null; permissions: { visibility: string } }>(
      `SELECT id, text, supersedes_id, permissions FROM signals
        WHERE workspace_id = $1 AND external_id = $2 ORDER BY ingested_at, id`,
      [workspaceId, externalId],
    )

  /** A re-run over the same window: the source serves everything again. */
  const rerun = (integrationId: string) =>
    db.admin.execute(`UPDATE integrations SET sync_cursor = NULL WHERE id = $1`, [integrationId])

  const at = '2026-11-01T09:00:00.000Z'

  it('BRAIN-1 AC3: an edited item is stored as a new signal superseding the original, which is unchanged', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector({ items: [{ id: 'item-1', text: 'first draft', at }], pageSize: 5 })
    await runner.sync(workspaceId, integrationId, connector)

    connector.script({ items: [{ id: 'item-1', text: 'second draft', at }], pageSize: 5 })
    await rerun(integrationId)
    const outcome = await runner.sync(workspaceId, integrationId, connector)

    expect(outcome.ingested).toBe(1)
    const [original, edit] = await versions(workspaceId, 'item-1')
    expect(original).toMatchObject({ text: 'first draft', supersedes_id: null })
    expect(edit).toMatchObject({ text: 'second draft', supersedes_id: original!.id })
  })

  it('BRAIN-1 AC2: re-running over unchanged content stores nothing new', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector({ items: [{ id: 'item-1', text: 'stable', at }], pageSize: 5 })
    await runner.sync(workspaceId, integrationId, connector)

    await rerun(integrationId)
    const outcome = await runner.sync(workspaceId, integrationId, connector)

    expect(outcome).toMatchObject({ ingested: 0, duplicates: 1 })
    expect(await versions(workspaceId, 'item-1')).toHaveLength(1)
  })

  it('BRAIN-1 AC3: a revert to earlier content is a new version, not a no-op', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector({ items: [{ id: 'item-1', text: 'A', at }], pageSize: 5 })
    await runner.sync(workspaceId, integrationId, connector)
    for (const text of ['B', 'A']) {
      connector.script({ items: [{ id: 'item-1', text, at }], pageSize: 5 })
      await rerun(integrationId)
      await runner.sync(workspaceId, integrationId, connector)
    }

    const chain = await versions(workspaceId, 'item-1')
    expect(chain.map((v) => v.text)).toEqual(['A', 'B', 'A'])
    expect(chain[1]!.supersedes_id).toBe(chain[0]!.id)
    expect(chain[2]!.supersedes_id).toBe(chain[1]!.id)
  })

  it('BRAIN-1 AC3: a change to who may see an item is a new version too', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector({ items: [{ id: 'item-1', text: 'same words', at }], pageSize: 5 })
    await runner.sync(workspaceId, integrationId, connector)

    connector.script({ items: [{ id: 'item-1', text: 'same words', at, restrictedTo: 'room-1' }], pageSize: 5 })
    await rerun(integrationId)
    await runner.sync(workspaceId, integrationId, connector)

    const chain = await versions(workspaceId, 'item-1')
    expect(chain.map((v) => v.permissions.visibility)).toEqual(['public', 'restricted'])
  })

  it('BRAIN-1 AC3: an edit arriving by webhook supersedes the version before it', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector()
    const deliver = (deliveryId: string, text: string) => {
      const raw = JSON.stringify({ id: 'hook-1', text, at })
      return receiver.receive(workspaceId, integrationId, connector, {
        headers: {
          'x-reference-delivery': deliveryId,
          'x-reference-signature': createHmac('sha256', SECRET).update(raw).digest('hex'),
        },
        body: raw,
      })
    }

    await deliver('d-1', 'as first reported')
    await deliver('d-2', 'as corrected')

    const chain = await versions(workspaceId, 'hook-1')
    expect(chain.map((v) => v.text)).toEqual(['as first reported', 'as corrected'])
    expect(chain[1]!.supersedes_id).toBe(chain[0]!.id)
  })
})
