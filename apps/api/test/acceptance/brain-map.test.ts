import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ulid, type EntityCandidate } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createEntityStore, createScopeMemberships } from '@chorus/brain'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type SignedInUser, type TestClient } from '@chorus/testing'

/**
 * BRAIN-6 — the brain map, over the API.
 *
 * The server half: `GET …/brain/map` returns the graph as nodes and edges
 * (AC1), with external-authority nodes carrying their source so the client can
 * render "authoritative elsewhere" instead of a compiled page (BRAIN-11 AC7),
 * and — the part easy to forget because the map feels like an aggregate — the
 * same permission predicate retrieval uses: an entity derived solely from a
 * source the caller cannot see is absent (AC6). Layout, WebGL rendering and the
 * freshness/drawer UI are the web surface.
 */
interface MapNode {
  id: string
  kind: string
  name: string
  salience: number
  authority: 'brain' | 'external'
  externalUri: string | null
}
interface MapEdge {
  from: string
  to: string
  relation: string
  confidence: number
}
interface BrainMap {
  nodes: MapNode[]
  edges: MapEdge[]
}

describe('BRAIN-6 the brain map route', () => {
  let db: IsolatedDatabase
  let client: TestClient

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    client = createTestClient(createApp({ dbConfig: db.config, mailer }), mailer)
  })

  const candidate = (over: Partial<EntityCandidate> & { externalId: string; name: string }): EntityCandidate => ({
    kind: 'feature',
    aliases: [],
    attributes: {},
    evidence: { signalExternalId: 'sig', source: 'reference' },
    ...over,
  })

  async function world() {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Mapped')
    const integrationId = ulid()
    await db.admin.execute(`INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'confluence')`, [
      integrationId,
      workspace.id,
    ])
    return { ada, workspaceId: workspace.id, integrationId }
  }

  async function signal(w: Awaited<ReturnType<typeof world>>, permissions: unknown): Promise<string> {
    const id = ulid()
    await db.admin.execute(
      `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions)
       VALUES ($1, $2, $3, 'reference', $1, 'page', 'x', now(), $4::jsonb)`,
      [id, w.workspaceId, w.integrationId, JSON.stringify(permissions)],
    )
    return id
  }

  function map(user: SignedInUser, workspaceId: string) {
    return user.get(`/workspaces/${workspaceId}/brain/map`)
  }

  it('BRAIN-6 AC1 / BRAIN-11 AC7: the map returns nodes and edges, external nodes carrying their source', async () => {
    const w = await world()
    const store = createEntityStore(db.config)
    const pub = await signal(w, { visibility: 'public', scopeIds: [] })
    const checkout = await store.upsertCandidate({
      workspaceId: w.workspaceId,
      candidate: candidate({ externalId: 'e:checkout', name: 'checkout' }),
      signalId: pub,
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
      signalId: pub,
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

    const response = await map(w.ada, w.workspaceId)
    expect(response.status, await response.clone().text()).toBe(200)
    const body = (await response.json()) as BrainMap

    expect(body.nodes.map((n) => n.name).sort()).toEqual(['checkout', 'payments'])
    const payNode = body.nodes.find((n) => n.name === 'payments')!
    expect(payNode).toMatchObject({ authority: 'external', externalUri: 'sdlckg://Service/payments', kind: 'service' })
    expect(body.nodes.find((n) => n.name === 'checkout')).toMatchObject({ authority: 'brain', externalUri: null })

    expect(body.edges).toHaveLength(1)
    expect(body.edges[0]).toMatchObject({
      from: checkout.entityId,
      to: payments.entityId,
      relation: 'depends_on',
      confidence: 1,
    })
  })

  it('BRAIN-6 AC6: an entity derived solely from a source the caller cannot see is absent', async () => {
    const w = await world()
    const store = createEntityStore(db.config)
    const pub = await signal(w, { visibility: 'public', scopeIds: [] })
    const restricted = await signal(w, { visibility: 'restricted', scopeIds: ['confluence:group:finance'] })
    await store.upsertCandidate({
      workspaceId: w.workspaceId,
      candidate: candidate({ externalId: 'e:open', name: 'openthing' }),
      signalId: pub,
      extractorVersion: 1,
    })
    await store.upsertCandidate({
      workspaceId: w.workspaceId,
      candidate: candidate({ externalId: 'e:secret', name: 'secretthing' }),
      signalId: restricted,
      extractorVersion: 1,
    })

    // Ada holds no external scopes, so the restricted-only entity is not hers to see.
    const response = await map(w.ada, w.workspaceId)
    const body = (await response.json()) as BrainMap
    expect(body.nodes.map((n) => n.name)).toEqual(['openthing'])
  })

  it('NFR-4 AC1 / AND1: a user who holds the source scope sees the restricted entity, until they lose it', async () => {
    const w = await world()
    const store = createEntityStore(db.config)
    const restricted = await signal(w, { visibility: 'restricted', scopeIds: ['confluence:group:finance'] })
    await store.upsertCandidate({
      workspaceId: w.workspaceId,
      candidate: candidate({ externalId: 'e:secret', name: 'secretthing' }),
      signalId: restricted,
      extractorVersion: 1,
    })
    const memberships = createScopeMemberships(db.config)
    const sync = (scopeIds: string[]) =>
      memberships.replace({
        workspaceId: w.workspaceId,
        userId: w.ada.userId,
        source: 'confluence',
        scopeIds,
        actor: { type: 'integration', id: w.integrationId },
      })
    const names = async () => ((await (await map(w.ada, w.workspaceId)).json()) as BrainMap).nodes.map((n) => n.name)

    // The connector's membership sync says Ada is in the finance group.
    await sync(['confluence:group:finance'])
    expect(await names()).toEqual(['secretthing'])

    // She leaves it upstream; the next sync drops the scope, and so does the map.
    await sync([])
    expect(await names()).toEqual([])
  })
})
