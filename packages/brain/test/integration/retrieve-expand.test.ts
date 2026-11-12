import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid, type EntityCandidate } from '@chorus/core'
import { createFakeModelProvider, type FakeModelProvider } from '@chorus/testing'
import {
  createEntityStore,
  createRetriever,
  type EntityFragment,
  type Fragment,
  type Retriever,
} from '../../src/index.js'

/**
 * BRAIN-4 AC3 — graph expansion adds related context.
 *
 * > Given a query matching an entity with related entities, when `expand: 1`,
 * > then directly related entities' summaries are included, marked as expansion
 * > rather than direct hits.
 *
 * Expansion is seeded from the entities a query actually matched and walks one
 * hop of `entity_edges`. A neighbour arrives carrying `viaExpansion` — it is
 * context, not evidence, and a model told otherwise cites it as though the
 * query had found it. This also carries external-authority neighbours into the
 * bundle, which is what BRAIN-11 AC5 (#252) needs.
 */
function entityFragment(fragment: Fragment | undefined): EntityFragment {
  expect(fragment?.kind).toBe('entity')
  return fragment as EntityFragment
}

describe('BRAIN-4 graph expansion (AC3)', () => {
  let db: IsolatedDatabase
  let models: FakeModelProvider
  let retriever: Retriever

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    models = createFakeModelProvider()
    retriever = createRetriever(db.config, { models, embeddingModel: { provider: 'fake', model: 'fake-embed' } })
  })

  const candidate = (over: Partial<EntityCandidate> & { externalId: string; name: string }): EntityCandidate => ({
    kind: 'feature',
    aliases: [],
    attributes: {},
    evidence: { signalExternalId: 'sig', source: 'reference' },
    ...over,
  })

  async function world(): Promise<{ workspaceId: string; userId: string; teamId: string; signalId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM entities WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    const [owner] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    const [team] = await db.admin.query<{ id: string }>(`SELECT id FROM teams WHERE workspace_id = $1 LIMIT 1`, [
      workspaceId,
    ])
    const [integration] = await db.admin.query<{ id: string }>(
      `SELECT id FROM integrations WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    const signalId = ulid()
    await db.admin.execute(
      `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions)
       VALUES ($1, $2, $3, 'reference', $1, 'issue', 'x', now(), '{"visibility":"public","scopeIds":[]}'::jsonb)`,
      [signalId, workspaceId, integration!.id],
    )
    return { workspaceId, userId: owner!.user_id, teamId: team!.id, signalId }
  }

  it('BRAIN-4 AC3: a related entity one hop away arrives marked as expansion, not a direct hit', async () => {
    const w = await world()
    const store = createEntityStore(db.config)

    // The query names "checkout"; "payments" is one edge away and shares no
    // terms with the query, so it can only reach the bundle by expansion.
    const checkout = await store.upsertCandidate({
      workspaceId: w.workspaceId,
      candidate: candidate({ externalId: 'e:checkout', name: 'checkout' }),
      signalId: w.signalId,
      extractorVersion: 1,
    })
    const payments = await store.upsertCandidate({
      workspaceId: w.workspaceId,
      candidate: candidate({
        kind: 'service',
        externalId: 'sdlckg:Service:payments',
        name: 'payments',
        authority: 'external',
        externalUri: 'sdlckg://Service/payments',
      }),
      signalId: w.signalId,
      extractorVersion: 1,
    })
    await store.addEdge({
      workspaceId: w.workspaceId,
      fromEntityId: checkout.entityId,
      toEntityId: payments.entityId,
      kind: 'depends_on',
      confidence: 1,
      extractorVersion: 1,
    })

    const bundle = await retriever.retrieve({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      userId: w.userId,
      query: 'checkout',
      kinds: ['entity'],
      expand: 1,
    })

    const direct = bundle.fragments.filter((f) => f.kind === 'entity' && !f.viaExpansion)
    const expanded = bundle.fragments.filter((f) => f.kind === 'entity' && f.viaExpansion)

    // The matched entity is a direct hit.
    expect(direct).toHaveLength(1)
    expect(entityFragment(direct[0]).name).toBe('checkout')
    expect(direct[0]!.sources.length).toBeGreaterThan(0)

    // Its neighbour arrived by expansion, marked as such and traceable to the
    // match it came from and the edge it came along.
    expect(expanded).toHaveLength(1)
    const neighbour = entityFragment(expanded[0])
    expect(neighbour.name).toBe('payments')
    expect(neighbour.authority).toBe('external')
    expect(neighbour.externalUri).toBe('sdlckg://Service/payments')
    expect(neighbour.viaExpansion).toMatchObject({ fromId: checkout.entityId, reason: 'depends_on' })
  })

  it('BRAIN-4 AC3: without expand, only the matched entity is returned', async () => {
    const w = await world()
    const store = createEntityStore(db.config)
    const checkout = await store.upsertCandidate({
      workspaceId: w.workspaceId,
      candidate: candidate({ externalId: 'e:checkout', name: 'checkout' }),
      signalId: w.signalId,
      extractorVersion: 1,
    })
    const payments = await store.upsertCandidate({
      workspaceId: w.workspaceId,
      candidate: candidate({ externalId: 'e:payments', name: 'payments' }),
      signalId: w.signalId,
      extractorVersion: 1,
    })
    await store.addEdge({
      workspaceId: w.workspaceId,
      fromEntityId: checkout.entityId,
      toEntityId: payments.entityId,
      kind: 'depends_on',
      confidence: 1,
      extractorVersion: 1,
    })

    const bundle = await retriever.retrieve({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      userId: w.userId,
      query: 'checkout',
      kinds: ['entity'],
    })

    expect(bundle.fragments.every((f) => !f.viaExpansion)).toBe(true)
    expect(bundle.fragments.filter((f) => f.kind === 'entity')).toHaveLength(1)
  })
})
