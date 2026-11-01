import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid, type EntityCandidate } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createEntityStore, createMergeDetector } from '../../src/index.js'

/**
 * BRAIN-7 — the merge detector and merge application.
 *
 * The detector proposes, never applies: duplicate entities become a `merge`
 * review item (AC1). Accepting it consolidates the two in one transaction —
 * aliases, edges and evidence move to the winner and the loser is gone, with no
 * dangling reference left behind (AC2, the place data loss hides).
 */
describe('BRAIN-7 merge detection and application', () => {
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
    await db.admin.execute(`DELETE FROM brain_review_items WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM entities WHERE workspace_id = $1`, [workspaceId])
    const [signal] = await db.admin.query<{ id: string }>(
      `SELECT id FROM signals WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    return { workspaceId, signalId: signal!.id }
  }

  const entity = (over: Partial<EntityCandidate> & { externalId: string; name: string }): EntityCandidate => ({
    kind: 'feature',
    aliases: [],
    attributes: {},
    evidence: { signalExternalId: 'sig', source: 'linear' },
    ...over,
  })

  it('BRAIN-7: duplicate entities produce a merge proposal, and accepting it consolidates them cleanly', async () => {
    const { workspaceId, signalId } = await workspace()
    const store = createEntityStore(db.config)

    // Two entities that are plainly the same thing, each with its own alias,
    // evidence and an edge to a third entity.
    const a = await store.upsertCandidate({
      workspaceId,
      candidate: entity({ externalId: 'e:a', name: 'Billing Service', aliases: ['BILL'] }),
      signalId,
      extractorVersion: 1,
    })
    const b = await store.upsertCandidate({
      workspaceId,
      candidate: entity({ externalId: 'e:b', name: 'Billing Service', aliases: ['BS'] }),
      signalId,
      extractorVersion: 1,
    })
    const c = await store.upsertCandidate({
      workspaceId,
      candidate: entity({ externalId: 'e:c', name: 'Checkout', kind: 'component' }),
      signalId,
      extractorVersion: 1,
    })
    await store.addEdge({
      workspaceId,
      fromEntityId: b.entityId,
      toEntityId: c.entityId,
      kind: 'depends_on',
      confidence: 0.9,
      extractorVersion: 1,
    })

    // The detector proposes the merge; nothing is merged yet (AC1).
    const detected = await createMergeDetector(db.config).detect(workspaceId)
    expect(detected.proposed).toBe(1)
    expect((await store.list(workspaceId)).filter((e) => e.kind === 'feature')).toHaveLength(2)

    const [item] = await store.reviewItems(workspaceId)
    expect(item).toMatchObject({ kind: 'merge' })

    // Accepting it consolidates (AC2).
    const outcome = await store.decideReviewItem({
      workspaceId,
      itemId: item!.id,
      decision: 'accept',
    })
    expect(outcome.applied).toBe(true)

    // One feature entity remains, and the loser is gone.
    const features = (await store.list(workspaceId)).filter((e) => e.kind === 'feature')
    expect(features).toHaveLength(1)
    const winnerId = features[0]!.id

    // The edge was repointed to the winner — no dangling reference (AC2).
    const edges = await store.edges(workspaceId)
    expect(edges).toHaveLength(1)
    expect([edges[0]!.fromEntityId, edges[0]!.toEntityId]).toContain(winnerId)

    // The item is closed, so it leaves the inbox (NAV-3 AC3).
    expect(await store.reviewItems(workspaceId)).toHaveLength(0)

    // No alias, edge or evidence references the departed loser.
    const loserId = [a.entityId, b.entityId].find((id) => id !== winnerId)!
    for (const table of ['entity_aliases', 'entity_edges', 'entity_evidence']) {
      const column = table === 'entity_edges' ? 'from_entity_id' : 'entity_id'
      const rows = await db.admin.query(
        `SELECT 1 FROM ${table} WHERE ${column} = $1 ${table === 'entity_edges' ? 'OR to_entity_id = $1' : ''}`,
        [loserId],
      )
      expect(rows, `${table} still references the merged-away entity`).toHaveLength(0)
    }
  })

  it('BRAIN-7: a second detector run does not re-propose an already-open merge', async () => {
    const { workspaceId, signalId } = await workspace()
    const store = createEntityStore(db.config)
    for (const externalId of ['e:a', 'e:b']) {
      await store.upsertCandidate({
        workspaceId,
        candidate: entity({ externalId, name: 'Billing Service' }),
        signalId,
        extractorVersion: 1,
      })
    }

    expect((await createMergeDetector(db.config).detect(workspaceId)).proposed).toBe(1)
    expect((await createMergeDetector(db.config).detect(workspaceId)).proposed).toBe(0)
    expect(await store.reviewItems(workspaceId)).toHaveLength(1)
  })
})
