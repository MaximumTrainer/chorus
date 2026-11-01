import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid, type EntityCandidate } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createFakeModelProvider } from '@chorus/testing'
import { createEntityStore, createMergeDetector, createSplitDetector } from '../../src/index.js'

/**
 * BRAIN-7 — split detection (AC3) and decision feedback (AC6), finishing the
 * four detectors.
 *
 * Split: an entity whose evidence embeddings form two clear clusters is
 * proposed for division, with the clusters shown. Feedback: a decided item is
 * the team's recorded correction, so a detector does not resurface it — a
 * rejected merge is not re-proposed on the next run.
 */
describe('BRAIN-7 split detection and decision feedback', () => {
  let db: IsolatedDatabase
  const embeddingModel = { provider: 'fake', model: 'fake-embed' }

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

  async function cleanWorkspace(): Promise<{ workspaceId: string; integrationId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM brain_review_items WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM entities WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    const [integration] = await db.admin.query<{ id: string }>(
      `SELECT id FROM integrations WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    return { workspaceId, integrationId: integration!.id }
  }

  async function addSignal(workspaceId: string, integrationId: string, text: string): Promise<string> {
    const id = ulid()
    await db.admin.execute(
      `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions)
       VALUES ($1, $2, $3, 'linear', $1, 'issue', $4, now(), '{"visibility":"public","scopeIds":[]}'::jsonb)`,
      [id, workspaceId, integrationId, text],
    )
    return id
  }

  it('BRAIN-7 AC3: an entity whose evidence forms two clusters is proposed for a split', async () => {
    const { workspaceId, integrationId } = await cleanWorkspace()
    const store = createEntityStore(db.config)
    // One entity fed by two plainly different bodies of evidence.
    const texts = [
      'billing invoice payment refund customer',
      'invoice billing payment charge customer',
      'kubernetes deploy pipeline cluster node',
      'pipeline deploy cluster kubernetes rollout',
    ]
    for (const text of texts) {
      await store.upsertCandidate({
        workspaceId,
        candidate: entity({ externalId: 'e:mixed', name: 'Mixed Thing' }),
        signalId: await addSignal(workspaceId, integrationId, text),
        extractorVersion: 1,
      })
    }

    const outcome = await createSplitDetector({
      config: db.config,
      models: createFakeModelProvider(),
      embeddingModel,
    }).detect(workspaceId)

    expect(outcome.proposed).toBe(1)
    const [item] = await store.reviewItems(workspaceId)
    expect(item?.kind).toBe('split')
    const subject = item!.subject as { clusterA: string[]; clusterB: string[] }
    expect(subject.clusterA.length).toBeGreaterThanOrEqual(2)
    expect(subject.clusterB.length).toBeGreaterThanOrEqual(2)
  })

  it('BRAIN-7 AC3: a cohesive entity is not split', async () => {
    const { workspaceId, integrationId } = await cleanWorkspace()
    const store = createEntityStore(db.config)
    for (const text of ['billing invoice payment', 'invoice billing payment', 'payment billing invoice', 'billing payment invoice']) {
      await store.upsertCandidate({
        workspaceId,
        candidate: entity({ externalId: 'e:cohesive', name: 'Billing' }),
        signalId: await addSignal(workspaceId, integrationId, text),
        extractorVersion: 1,
      })
    }
    const outcome = await createSplitDetector({ config: db.config, models: createFakeModelProvider(), embeddingModel }).detect(workspaceId)
    expect(outcome.proposed).toBe(0)
  })

  it('BRAIN-7 AC6: a rejected merge is not re-proposed on the next run', async () => {
    const { workspaceId, integrationId } = await cleanWorkspace()
    const store = createEntityStore(db.config)
    const signalId = await addSignal(workspaceId, integrationId, 'billing')
    for (const externalId of ['e:a', 'e:b']) {
      await store.upsertCandidate({
        workspaceId,
        candidate: entity({ externalId, name: 'Billing Service' }),
        signalId,
        extractorVersion: 1,
      })
    }

    // Propose, then reject.
    expect((await createMergeDetector(db.config).detect(workspaceId)).proposed).toBe(1)
    const [item] = await store.reviewItems(workspaceId)
    await store.decideReviewItem({ workspaceId, itemId: item!.id, decision: 'reject' })

    // The correction sticks: a second run does not raise it again (AC6).
    expect((await createMergeDetector(db.config).detect(workspaceId)).proposed).toBe(0)
    expect(await store.reviewItems(workspaceId)).toHaveLength(0)
  })
})
