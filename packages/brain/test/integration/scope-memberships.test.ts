import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid, type EntityCandidate } from '@chorus/core'
import { createFakeModelProvider } from '@chorus/testing'
import {
  createBrainMap,
  createEntityStore,
  createRetriever,
  createScopeMemberships,
  type Retriever,
} from '../../src/index.js'

/**
 * NFR-4 AC1 and AND1 — source permissions propagate end to end, and losing
 * access takes effect.
 *
 * Retrieval and the brain map already refuse a restricted signal to a caller
 * holding none of its scopes. What was missing is the other half: knowing which
 * scopes a user *does* hold. A connector sync records a user's memberships of
 * source scopes (a Confluence group, a Slack channel); the retriever and the
 * map resolve them from the `userId` they already receive, so no caller has to
 * remember to pass them — chat, search, MCP and the map all inherit one answer.
 * A sync replaces a user's memberships from that source, so a scope dropped
 * upstream is dropped here, and the next retrieval no longer sees what it
 * gated.
 */
describe('NFR-4 source scope memberships', () => {
  let db: IsolatedDatabase
  let retriever: Retriever

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    retriever = createRetriever(db.config, {
      models: createFakeModelProvider(),
      embeddingModel: { provider: 'fake', model: 'fake-embed' },
    })
  })

  const FINANCE = 'confluence:group:finance'

  async function world() {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM entities WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    // The tenancy seed gives the owner a membership; start each case from none.
    await db.admin.execute(`DELETE FROM source_scope_memberships WHERE workspace_id = $1`, [workspaceId])
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
    // A second workspace member, who is never in the finance group.
    const otherId = ulid()
    await db.admin.execute(`INSERT INTO users (id, email, name, email_verified) VALUES ($1, $2, 'Other', true)`, [
      otherId,
      `other-${otherId}@example.test`,
    ])
    await db.admin.execute(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES ($1, $2, $3, 'member')`,
      [ulid(), workspaceId, otherId],
    )

    // Restricted content: a finance-only page, and the entity extracted from it.
    const signalId = ulid()
    await db.admin.execute(
      `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions)
       VALUES ($1, $2, $3, 'confluence', $1, 'page', 'the quarterly figures are finance only', now(), $4::jsonb)`,
      [signalId, workspaceId, integration!.id, JSON.stringify({ visibility: 'restricted', scopeIds: [FINANCE] })],
    )
    const candidate: EntityCandidate = {
      kind: 'feature',
      externalId: 'e:forecast',
      name: 'forecast',
      aliases: [],
      attributes: {},
      evidence: { signalExternalId: signalId, source: 'confluence' },
    }
    await createEntityStore(db.config).upsertCandidate({ workspaceId, candidate, signalId, extractorVersion: 1 })

    return {
      workspaceId,
      teamId: team!.id,
      memberId: owner!.user_id,
      otherId,
      integrationId: integration!.id,
    }
  }

  const sync = (w: Awaited<ReturnType<typeof world>>, userId: string, scopeIds: string[]) =>
    createScopeMemberships(db.config).replace({
      workspaceId: w.workspaceId,
      userId,
      source: 'confluence',
      scopeIds,
      actor: { type: 'integration', id: w.integrationId },
    })

  const signalsFor = async (w: Awaited<ReturnType<typeof world>>, userId: string) =>
    (
      await retriever.retrieve({
        workspaceId: w.workspaceId,
        teamId: w.teamId,
        userId,
        query: 'quarterly figures',
        kinds: ['signal'],
      })
    ).fragments.filter((f) => f.kind === 'signal').length

  const mapNamesFor = async (w: Awaited<ReturnType<typeof world>>, userId: string) =>
    (await createBrainMap(db.config).read({ workspaceId: w.workspaceId, userId })).nodes.map((n) => n.name)

  it('NFR-4 AC1: a user holding the source scope retrieves restricted content; one without does not', async () => {
    const w = await world()
    await sync(w, w.memberId, [FINANCE])

    // Neither call passes scopes: retrieval resolves them from the user.
    expect(await signalsFor(w, w.memberId)).toBe(1)
    expect(await signalsFor(w, w.otherId)).toBe(0)
  })

  it('NFR-4 AC1: the brain map follows the same memberships', async () => {
    const w = await world()
    await sync(w, w.memberId, [FINANCE])

    expect(await mapNamesFor(w, w.memberId)).toEqual(['forecast'])
    expect(await mapNamesFor(w, w.otherId)).toEqual([])
    const drawer = await createBrainMap(db.config).drawer({
      workspaceId: w.workspaceId,
      userId: w.otherId,
      entityId: (await createEntityStore(db.config).findByExternalId(w.workspaceId, 'e:forecast'))!,
    })
    expect(drawer).toBeNull()
  })

  it('NFR-4 AND1: losing access takes effect on the next retrieval', async () => {
    const w = await world()
    await sync(w, w.memberId, [FINANCE])
    expect(await signalsFor(w, w.memberId)).toBe(1)

    // The user leaves the finance group upstream; the next sync drops the scope.
    await sync(w, w.memberId, [])

    expect(await signalsFor(w, w.memberId)).toBe(0)
    expect(await mapNamesFor(w, w.memberId)).toEqual([])
  })

  it('NFR-4: a sync replaces only that source, is idempotent, and is audited', async () => {
    const w = await world()
    const memberships = createScopeMemberships(db.config)
    // A scope from another source survives a confluence sync.
    await memberships.replace({
      workspaceId: w.workspaceId,
      userId: w.memberId,
      source: 'slack',
      scopeIds: ['slack:channel:general'],
      actor: { type: 'integration', id: w.integrationId },
    })

    const first = await sync(w, w.memberId, [FINANCE])
    const again = await sync(w, w.memberId, [FINANCE])
    expect(first).toEqual({ added: 1, removed: 0 })
    expect(again).toEqual({ added: 0, removed: 0 })

    expect((await memberships.scopesFor(w.workspaceId, w.memberId)).sort()).toEqual(
      [FINANCE, 'slack:channel:general'].sort(),
    )

    const audit = await db.admin.query<{ action: string; actor_type: string; actor_id: string }>(
      `SELECT action, actor_type, actor_id FROM audit_events
        WHERE workspace_id = $1 AND action = 'source_scope.sync' ORDER BY at, id`,
      [w.workspaceId],
    )
    // One row per sync that ran — the no-op included, so "nothing changed" is on the record too.
    expect(audit).toHaveLength(3)
    expect(audit[0]).toMatchObject({ actor_type: 'integration', actor_id: w.integrationId })
  })
})
