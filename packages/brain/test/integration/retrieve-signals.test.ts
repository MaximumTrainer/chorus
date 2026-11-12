import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid } from '@chorus/core'
import { createFakeModelProvider, type FakeModelProvider } from '@chorus/testing'
import { createRetriever, type Retriever, type SignalFragment, type Fragment } from '../../src/index.js'

/**
 * BRAIN-4 — retrieval widened to signals, with the per-signal permission scope
 * enforced in the query (AC2, and the #242 enforcement half).
 *
 * A signal's permission scope is captured at ingest and re-checked here. The
 * check is **fail-closed**: a `restricted` signal is a candidate only when the
 * caller's own scopes intersect its scopes, so a signal a caller may not see is
 * never a candidate and cannot leak through a count. Resolving a caller's scope
 * ids from their memberships (identity-linking) is a separate concern; this
 * takes them on the query, so retrieval is complete and callers can be wired as
 * that lands.
 */
function signal(fragment: Fragment | undefined): SignalFragment {
  expect(fragment?.kind).toBe('signal')
  return fragment as SignalFragment
}

describe('BRAIN-4 signal retrieval and permission scopes', () => {
  let db: IsolatedDatabase
  let models: FakeModelProvider
  let retriever: Retriever

  interface World {
    workspaceId: string
    userId: string
    teamId: string
    integrationId: string
  }

  async function world(): Promise<World> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
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
    return { workspaceId, userId: owner!.user_id, teamId: team!.id, integrationId: integration!.id }
  }

  async function addSignal(
    w: World,
    input: { text: string; permissions: unknown; kind?: string; url?: string },
  ): Promise<string> {
    const id = ulid()
    await db.admin.execute(
      `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, url, permissions)
       VALUES ($1, $2, $3, 'reference', $1, $4, $5, now(), $6, $7::jsonb)`,
      [id, w.workspaceId, w.integrationId, input.kind ?? 'page', input.text, input.url ?? null, JSON.stringify(input.permissions)],
    )
    return id
  }

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

  it('BRAIN-4: a public signal is retrievable and carries enough to open it', async () => {
    const w = await world()
    const id = await addSignal(w, {
      text: 'parseInvoice balances the ledger',
      permissions: { visibility: 'public', scopeIds: [] },
      url: 'https://wiki.test/page/1',
    })

    const bundle = await retriever.retrieve({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      userId: w.userId,
      query: 'parseInvoice',
      kinds: ['signal'],
    })

    expect(bundle.fragments.filter((f) => f.kind === 'signal')).toHaveLength(1)
    expect(signal(bundle.fragments[0])).toMatchObject({ signalId: id, source: 'reference', url: 'https://wiki.test/page/1' })
  })

  it('BRAIN-4 AC2: a restricted signal is absent when the caller holds none of its scopes, and the count does not leak it', async () => {
    const w = await world()
    await addSignal(w, {
      text: 'the quarterly figures look strong',
      permissions: { visibility: 'public', scopeIds: [] },
    })
    await addSignal(w, {
      text: 'the quarterly figures are restricted to finance',
      permissions: { visibility: 'restricted', scopeIds: ['confluence:group:finance'] },
    })

    // The caller holds no scopes — fail closed.
    const bundle = await retriever.retrieve({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      userId: w.userId,
      query: 'quarterly figures',
      kinds: ['signal'],
      k: 10,
    })

    expect(bundle.fragments.filter((f) => f.kind === 'signal')).toHaveLength(1)
    expect(signal(bundle.fragments[0]).text).toContain('look strong')
    // The restricted signal was never a candidate, so `considered` cannot reveal it.
    expect(bundle.considered).toBe(1)
  })

  it('BRAIN-4 AC2: a restricted signal is retrievable by a caller whose scopes intersect its own', async () => {
    const w = await world()
    await addSignal(w, {
      text: 'the quarterly figures are restricted to finance',
      permissions: { visibility: 'restricted', scopeIds: ['confluence:group:finance'] },
    })

    const bundle = await retriever.retrieve({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      userId: w.userId,
      query: 'quarterly figures',
      kinds: ['signal'],
      viewerScopeIds: ['confluence:group:finance', 'confluence:group:eng'],
    })

    expect(bundle.fragments.filter((f) => f.kind === 'signal')).toHaveLength(1)
    expect(signal(bundle.fragments[0]).text).toContain('restricted to finance')
  })
})
