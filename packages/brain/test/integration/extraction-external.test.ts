import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid, type EntityCandidate } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createEntityStore, createExtractionIngestor } from '../../src/index.js'

/**
 * BRAIN-11 AC2 — extraction links to external entities, never creates them.
 *
 * A model candidate whose name matches an external-authority entity resolves to
 * it — so the batch's edges point at the owning graph's node — and no brain
 * duplicate is minted. A candidate of an operational kind with no external
 * entity behind it is dropped and counted, never invented.
 */
describe('BRAIN-11 extraction and external authority (AC2)', () => {
  let db: IsolatedDatabase

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  async function workspace(): Promise<{ workspaceId: string; signalId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM entities WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    const integrationId = (
      await db.admin.query<{ id: string }>(`SELECT id FROM integrations WHERE workspace_id = $1 LIMIT 1`, [workspaceId])
    )[0]!.id
    const signalId = ulid()
    await db.admin.execute(
      `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, occurred_at, permissions)
       VALUES ($1, $2, $3, 'reference', $1, 'issue', now(), '{"visibility":"public","scopeIds":[]}'::jsonb)`,
      [signalId, workspaceId, integrationId],
    )
    return { workspaceId, signalId }
  }

  const entity = (over: Partial<EntityCandidate> & { externalId: string; name: string }): EntityCandidate => ({
    kind: 'feature',
    aliases: [],
    attributes: {},
    evidence: { signalExternalId: 'sig', source: 'reference' },
    ...over,
  })

  it('BRAIN-11 AC2: a candidate matching an external entity links to it and mints nothing', async () => {
    const { workspaceId, signalId } = await workspace()
    const store = createEntityStore(db.config)

    // The owning graph's Service, already in the brain as an external reference.
    const checkout = await store.upsertCandidate({
      workspaceId,
      candidate: entity({ kind: 'service', externalId: 'sdlckg:Service:checkout', name: 'checkout', authority: 'external', externalUri: 'sdlckg://Service/checkout' }),
      signalId,
      extractorVersion: 1,
    })

    // The model extracts a "checkout" component and "payments depends_on checkout",
    // plus a service it invented with nothing behind it.
    const outcome = await createExtractionIngestor(store).ingest(workspaceId, {
      signalId,
      extractorVersion: 2,
      entities: [
        entity({ kind: 'component', externalId: 'llm:checkout', name: 'checkout' }),
        entity({ kind: 'feature', externalId: 'llm:payments', name: 'payments' }),
        entity({ kind: 'service', externalId: 'llm:ghost', name: 'ghost-service' }),
      ],
      edges: [
        { kind: 'depends_on', fromExternalId: 'llm:payments', toExternalId: 'llm:checkout', confidence: 0.9, evidence: { signalExternalId: 'sig', source: 'reference' } },
      ],
    })

    // The matching candidate linked to the external entity; the invented service
    // was dropped, counted, never minted.
    expect(outcome.linkedExternal).toBe(1)
    expect(outcome.unresolvedExternal).toBe(1)

    // No brain-minted "checkout" — only the external Service exists.
    const entities = await store.list(workspaceId)
    const checkouts = entities.filter((e) => e.name.toLowerCase() === 'checkout')
    expect(checkouts).toHaveLength(1)
    expect(checkouts[0]!.id).toBe(checkout.entityId)
    // The invented service is not there either.
    expect(entities.some((e) => e.name === 'ghost-service')).toBe(false)

    // The depends_on edge points payments at the external Service, not a copy.
    const paymentsId = await store.findByExternalId(workspaceId, 'llm:payments')
    const edges = await store.edges(workspaceId)
    expect(edges).toContainEqual({ fromEntityId: paymentsId, toEntityId: checkout.entityId, kind: 'depends_on' })
  })
})
