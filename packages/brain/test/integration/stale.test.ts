import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid, type EntityCandidate } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createEntityStore, createStaleDetector } from '../../src/index.js'

/**
 * BRAIN-7 AC4 — stale detection is precise.
 *
 * Only entities with no new evidence *and* a current reference are flagged. An
 * entity that is simply old and unreferenced is not: nobody is relying on it,
 * and flagging it would make the inbox noise nobody clears.
 */
describe('BRAIN-7 stale detection', () => {
  let db: IsolatedDatabase

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  const entity = (over: Partial<EntityCandidate> & { externalId: string; name: string }): EntityCandidate => ({
    kind: 'feature',
    aliases: [],
    attributes: {},
    evidence: { signalExternalId: 'sig', source: 'linear' },
    ...over,
  })

  async function setup() {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM brain_review_items WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM entities WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    const [integration] = await db.admin.query<{ id: string }>(
      `SELECT id FROM integrations WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    const store = createEntityStore(db.config)

    // Insert a signal with a chosen age that mentions a name.
    const addSignal = async (text: string, ingestedDaysAgo: number) => {
      const id = ulid()
      await db.admin.execute(
        `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, ingested_at, permissions)
         VALUES ($1, $2, $3, 'linear', $1, 'issue', $4, now(), now() - ($5 || ' days')::interval,
                 '{"visibility":"public","scopeIds":[]}'::jsonb)`,
        [id, workspaceId, integration!.id, text, String(ingestedDaysAgo)],
      )
      return id
    }

    // Create an entity, then age its evidence to a chosen number of days.
    const addEntity = async (externalId: string, name: string, evidenceDaysAgo: number, signalId: string) => {
      const { entityId } = await store.upsertCandidate({
        workspaceId,
        candidate: entity({ externalId, name }),
        signalId,
        extractorVersion: 1,
      })
      await db.admin.execute(
        `UPDATE entity_evidence SET created_at = now() - ($2 || ' days')::interval WHERE entity_id = $1`,
        [entityId, String(evidenceDaysAgo)],
      )
      return entityId
    }

    return { workspaceId, store, addSignal, addEntity }
  }

  it('BRAIN-7 AC4: flags a referenced-but-unfed entity, and not an old unreferenced one', async () => {
    const { workspaceId, store, addSignal, addEntity } = await setup()

    // Referenced-but-unfed: evidence is 60 days old, but a signal 3 days ago mentions it.
    const recent = await addSignal('still working on the Payments Gateway', 3)
    const old = await addSignal('old note about the Payments Gateway', 90)
    const unfed = await addEntity('e:gateway', 'Payments Gateway', 60, old)

    // Old and unreferenced: evidence 60 days old, no recent mention.
    await addEntity('e:legacy', 'Legacy Importer', 60, old)
    void recent

    const outcome = await createStaleDetector(db.config).detect(workspaceId)
    expect(outcome.proposed).toBe(1)

    const items = await store.reviewItems(workspaceId)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'stale',
      subject: { entity: { entityId: unfed } },
    })
  })

  it('BRAIN-7 AC4: a recently-fed entity is not flagged, even if referenced', async () => {
    const { workspaceId, store, addSignal, addEntity } = await setup()
    const signal = await addSignal('the Billing Service is active', 2)
    await addEntity('e:billing', 'Billing Service', 1, signal) // fed yesterday

    expect((await createStaleDetector(db.config).detect(workspaceId)).proposed).toBe(0)
    expect(await store.reviewItems(workspaceId)).toHaveLength(0)
  })

  it('BRAIN-7 AC4: a second run does not re-flag an already-open stale item', async () => {
    const { workspaceId, store, addSignal, addEntity } = await setup()
    const signal = await addSignal('the Payments Gateway again', 3)
    await addEntity('e:gateway', 'Payments Gateway', 60, signal)

    expect((await createStaleDetector(db.config).detect(workspaceId)).proposed).toBe(1)
    expect((await createStaleDetector(db.config).detect(workspaceId)).proposed).toBe(0)
    expect(await store.reviewItems(workspaceId)).toHaveLength(1)
  })
})
