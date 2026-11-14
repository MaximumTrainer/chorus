import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid, type EntityCandidate } from '@chorus/core'
import { createFakeModelProvider } from '@chorus/testing'
import { createBrainMap, createEntityStore, createRetriever, createScopeMemberships } from '../../src/index.js'

/**
 * BRAIN-1 AC3, read side — only an item's current version counts.
 *
 * Signals are append-only: an edited item is a new signal superseding the old.
 * Everything that decides what someone may see therefore reads current versions
 * only. A page that was public and is now restricted must not stay visible
 * through its superseded public row — not in retrieval, not on the brain map —
 * and an edited page surfaces its current words, not both drafts.
 */
describe('BRAIN-1 current signal versions', () => {
  let db: IsolatedDatabase

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  async function world() {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    for (const table of ['entities', 'signals', 'source_scope_memberships']) {
      await db.admin.execute(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId])
    }
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
    return { workspaceId, userId: owner!.user_id, teamId: team!.id, integrationId: integration!.id }
  }

  /** Writes one version of item `externalId`, superseding `supersedes` if given. */
  async function version(
    w: Awaited<ReturnType<typeof world>>,
    externalId: string,
    text: string,
    permissions: unknown,
    supersedes: string | null,
  ): Promise<string> {
    const id = ulid()
    await db.admin.execute(
      `INSERT INTO signals
         (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions, supersedes_id)
       VALUES ($1, $2, $3, 'confluence', $4, 'page', $5, now(), $6::jsonb, $7)`,
      [id, w.workspaceId, w.integrationId, externalId, text, JSON.stringify(permissions), supersedes],
    )
    return id
  }

  const PUBLIC = { visibility: 'public', scopeIds: [] }
  const FINANCE = { visibility: 'restricted', scopeIds: ['confluence:group:finance'] }

  const retriever = () =>
    createRetriever(db.config, { models: createFakeModelProvider(), embeddingModel: { provider: 'fake', model: 'fake-embed' } })

  const textsFor = async (w: Awaited<ReturnType<typeof world>>, query: string) =>
    (
      await retriever().retrieve({ workspaceId: w.workspaceId, teamId: w.teamId, userId: w.userId, query, kinds: ['signal'] })
    ).fragments.map((f) => f.text)

  it('BRAIN-1 AC3: a page that became restricted is not visible through its old public version', async () => {
    const w = await world()
    const v1 = await version(w, 'page-1', 'the launch date is in march', PUBLIC, null)
    await version(w, 'page-1', 'the launch date is in march', FINANCE, v1)

    expect(await textsFor(w, 'launch date')).toEqual([])

    // Someone in finance sees it — once, as its current version.
    await createScopeMemberships(db.config).replace({
      workspaceId: w.workspaceId,
      userId: w.userId,
      source: 'confluence',
      scopeIds: ['confluence:group:finance'],
      actor: { type: 'system' },
    })
    expect(await textsFor(w, 'launch date')).toEqual(['the launch date is in march'])
  })

  it('BRAIN-1 AC3: an edited page surfaces its current words, not both drafts', async () => {
    const w = await world()
    const v1 = await version(w, 'page-2', 'deploy freeze starts friday', PUBLIC, null)
    await version(w, 'page-2', 'deploy freeze is lifted', PUBLIC, v1)

    expect(await textsFor(w, 'deploy freeze')).toEqual(['deploy freeze is lifted'])
  })

  it('BRAIN-1 AC3: the brain map does not show an entity through a superseded public version', async () => {
    const w = await world()
    const v1 = await version(w, 'page-3', 'the forecast', PUBLIC, null)
    const v2 = await version(w, 'page-3', 'the forecast', FINANCE, v1)
    const store = createEntityStore(db.config)
    const candidate: EntityCandidate = {
      kind: 'feature',
      externalId: 'e:forecast',
      name: 'forecast',
      aliases: [],
      attributes: {},
      evidence: { signalExternalId: 'page-3', source: 'confluence' },
    }
    // Extracted from both versions, as re-extraction after an edit would.
    const { entityId } = await store.upsertCandidate({ workspaceId: w.workspaceId, candidate, signalId: v1, extractorVersion: 1 })
    await store.upsertCandidate({ workspaceId: w.workspaceId, candidate, signalId: v2, extractorVersion: 1 })

    const map = createBrainMap(db.config)
    expect((await map.read({ workspaceId: w.workspaceId, userId: w.userId })).nodes).toEqual([])
    expect(await map.drawer({ workspaceId: w.workspaceId, userId: w.userId, entityId })).toBeNull()
  })
})
