import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid, type EdgeCandidate, type EntityCandidate } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createEntityStore, createExtractionIngestor } from '../../src/index.js'

/**
 * BRAIN-3 AC3 — resolution merges only when confident.
 *
 * A candidate that matches an existing entity above the threshold is merged
 * into it automatically; one that matches only plausibly becomes a `merge`
 * review item rather than a silent merge — never an automatic merge below the
 * threshold. Edges the pass proposes are persisted against the resolved
 * entities.
 */
describe('BRAIN-3 extraction resolution', () => {
  let db: IsolatedDatabase

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  async function workspace(): Promise<string> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    // Clear the seeded graph so each test starts empty: deleting entities
    // cascades edges, aliases and evidence; review items carry no such FK.
    await db.admin.execute(`DELETE FROM brain_review_items WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM entities WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    return workspaceId
  }

  async function signal(workspaceId: string): Promise<string> {
    const [integration] = await db.admin.query<{ id: string }>(
      `SELECT id FROM integrations WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    const signalId = ulid()
    await db.admin.execute(
      `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, occurred_at, permissions)
       VALUES ($1, $2, $3, 'linear', $1, 'issue', now(), '{"visibility":"public","scopeIds":[]}'::jsonb)`,
      [signalId, workspaceId, integration!.id],
    )
    return signalId
  }

  const entity = (over: Partial<EntityCandidate> & { externalId: string; name: string }): EntityCandidate => ({
    kind: 'feature',
    aliases: [],
    attributes: {},
    evidence: { signalExternalId: 'sig', source: 'linear' },
    ...over,
  })

  it('BRAIN-3 AC3: a confident name match merges automatically, not a second entity', async () => {
    const workspaceId = await workspace()
    const signalId = await signal(workspaceId)
    const store = createEntityStore(db.config)
    const ingest = createExtractionIngestor(store)

    // An existing entity.
    await store.upsertCandidate({
      workspaceId,
      candidate: entity({ externalId: 'linear:project:1', name: 'Billing Service' }),
      signalId,
      extractorVersion: 1,
    })

    // A candidate with the same name under a different external id.
    const outcome = await ingest.ingest(workspaceId, {
      signalId,
      extractorVersion: 1,
      entities: [entity({ externalId: 'llm:billing', name: 'Billing Service' })],
      edges: [],
    })

    expect(outcome.merged).toBe(1)
    expect((await store.list(workspaceId)).filter((e) => e.kind === 'feature')).toHaveLength(1)
    expect(await store.reviewItems(workspaceId)).toHaveLength(0)
  })

  it('BRAIN-3 AC3: a plausible-but-weak match becomes a review item, and both entities remain', async () => {
    const workspaceId = await workspace()
    const signalId = await signal(workspaceId)
    const store = createEntityStore(db.config)
    const ingest = createExtractionIngestor(store)

    await store.upsertCandidate({
      workspaceId,
      candidate: entity({ externalId: 'linear:project:1', name: 'Billing Service' }),
      signalId,
      extractorVersion: 1,
    })

    const outcome = await ingest.ingest(workspaceId, {
      signalId,
      extractorVersion: 1,
      entities: [entity({ externalId: 'llm:billing2', name: 'Biling Service' })],
      edges: [],
    })

    // Not merged: a review item proposes it, and both entities still exist (AC3).
    expect(outcome.merged).toBe(0)
    expect(outcome.reviewItems).toBe(1)
    const items = await store.reviewItems(workspaceId)
    expect(items[0]).toMatchObject({ kind: 'merge' })
    expect((await store.list(workspaceId)).filter((e) => e.kind === 'feature')).toHaveLength(2)
  })

  it('BRAIN-3: proposed edges are persisted against the resolved entities', async () => {
    const workspaceId = await workspace()
    const signalId = await signal(workspaceId)
    const store = createEntityStore(db.config)
    const ingest = createExtractionIngestor(store)

    const edge: EdgeCandidate = {
      kind: 'depends_on',
      fromExternalId: 'llm:a',
      toExternalId: 'llm:b',
      confidence: 0.9,
      evidence: { signalExternalId: 'sig', source: 'linear' },
    }
    const outcome = await ingest.ingest(workspaceId, {
      signalId,
      extractorVersion: 1,
      entities: [
        entity({ externalId: 'llm:a', name: 'Parser', kind: 'component' }),
        entity({ externalId: 'llm:b', name: 'Validator', kind: 'component' }),
      ],
      edges: [edge],
    })

    expect(outcome.edges).toBe(1)
    const edges = await store.edges(workspaceId)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ kind: 'depends_on' })
  })
})
