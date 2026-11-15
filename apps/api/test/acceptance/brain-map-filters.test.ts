import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ulid, type EntityCandidate } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createEntityStore } from '@chorus/brain'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type SignedInUser, type TestClient } from '@chorus/testing'

/**
 * BRAIN-6 AC2 — the map's filters.
 *
 * Filters by kind, source and time window narrow the nodes, and the narrowing
 * is honest: an entity is kept only when it still has visible evidence that
 * passes the filter, so `salience` and `lastActivityAt` — computed over the
 * surviving evidence — match what is shown, and the edges fall away with their
 * endpoints.
 */
interface MapNode {
  id: string
  name: string
  kind: string
}
interface BrainMap {
  nodes: MapNode[]
  edges: unknown[]
}

describe('BRAIN-6 the map filters', () => {
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
    const workspace = await ada.createWorkspace('Filtered')
    const integrationId = ulid()
    await db.admin.execute(`INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'jira')`, [
      integrationId,
      workspace.id,
    ])
    return { ada, workspaceId: workspace.id, integrationId }
  }

  async function signal(
    w: Awaited<ReturnType<typeof world>>,
    input: { source: string; agoDays?: number },
  ): Promise<string> {
    const id = ulid()
    await db.admin.execute(
      `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions)
       VALUES ($1, $2, $3, $4, $1, 'page', 'x', now() - ($5 || ' days')::interval, '{"visibility":"public","scopeIds":[]}'::jsonb)`,
      [id, w.workspaceId, w.integrationId, input.source, String(input.agoDays ?? 0)],
    )
    return id
  }

  async function seed(w: Awaited<ReturnType<typeof world>>) {
    const store = createEntityStore(db.config)
    const jiraRecent = await signal(w, { source: 'jira', agoDays: 1 })
    const confluenceOld = await signal(w, { source: 'confluence', agoDays: 400 })
    await store.upsertCandidate({
      workspaceId: w.workspaceId,
      candidate: candidate({ externalId: 'e:alpha', name: 'alpha', kind: 'feature' }),
      signalId: jiraRecent,
      extractorVersion: 1,
    })
    await store.upsertCandidate({
      workspaceId: w.workspaceId,
      candidate: candidate({
        externalId: 'sdlckg:Service:beta',
        name: 'beta',
        kind: 'service',
        authority: 'external',
        externalUri: 'sdlckg://Service/beta',
      }),
      signalId: confluenceOld,
      extractorVersion: 1,
    })
  }

  async function names(user: SignedInUser, workspaceId: string, query: string): Promise<string[]> {
    const res = await user.get(`/workspaces/${workspaceId}/brain/map${query}`)
    expect(res.status, await res.clone().text()).toBe(200)
    return ((await res.json()) as BrainMap).nodes.map((n) => n.name).sort()
  }

  it('BRAIN-6 AC2: no filter returns the whole visible graph', async () => {
    const w = await world()
    await seed(w)
    expect(await names(w.ada, w.workspaceId, '')).toEqual(['alpha', 'beta'])
  })

  it('BRAIN-6 AC2: a kind filter keeps only matching nodes', async () => {
    const w = await world()
    await seed(w)
    expect(await names(w.ada, w.workspaceId, '?kind=service')).toEqual(['beta'])
  })

  it('BRAIN-6 AC2: a source filter keeps only entities evidenced by that source', async () => {
    const w = await world()
    await seed(w)
    expect(await names(w.ada, w.workspaceId, '?source=jira')).toEqual(['alpha'])
  })

  it('BRAIN-6 AC2: a time window keeps only entities with evidence inside it', async () => {
    const w = await world()
    await seed(w)
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    expect(await names(w.ada, w.workspaceId, `?since=${encodeURIComponent(since)}`)).toEqual(['alpha'])
  })
})
