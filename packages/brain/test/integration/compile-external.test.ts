import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid, type EntityCandidate } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createEntityStore, createWikiCompiler } from '../../src/index.js'

/**
 * BRAIN-11 AC6 — the wiki compiler and external-authority entities.
 *
 * An external-authority entity is a reference the owning graph holds. When it
 * clears the salience threshold it earns a link block on the pages that relate
 * to it — name linking to the source URI, with its kind and owner — but never a
 * page of its own: the owning system, not Chorus, is its source of truth.
 */
describe('BRAIN-11 wiki compilation and external authority (AC6)', () => {
  let db: IsolatedDatabase

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

  async function setup() {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM wiki_pages WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM entities WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    const [integration] = await db.admin.query<{ id: string }>(
      `SELECT id FROM integrations WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    return { workspaceId, integrationId: integration!.id, store: createEntityStore(db.config) }
  }

  async function signal(workspaceId: string, integrationId: string, externalId: string): Promise<string> {
    const id = ulid()
    await db.admin.execute(
      `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, url, permissions)
       VALUES ($1, $2, $3, 'linear', $4, 'issue', 'a claim', now(), $5, '{"visibility":"public","scopeIds":[]}'::jsonb)`,
      [id, workspaceId, integrationId, externalId, `https://x.test/${externalId}`],
    )
    return id
  }

  async function pageFor(entityId: string) {
    const [row] = await db.admin.query<{ slug: string; markdown: string }>(
      `SELECT slug, markdown FROM wiki_pages WHERE entity_id = $1`,
      [entityId],
    )
    return row
  }

  it('BRAIN-11 AC6: an external entity is a link block on a related page, never a page of its own', async () => {
    const { workspaceId, integrationId, store } = await setup()

    // A brain-authority feature, made salient by two signals and an edge.
    const s1 = await signal(workspaceId, integrationId, 'ACME-1')
    const s2 = await signal(workspaceId, integrationId, 'ACME-2')
    const checkout = await store.upsertCandidate({
      workspaceId,
      candidate: entity({ externalId: 'e:checkout', name: 'Checkout' }),
      signalId: s1,
      extractorVersion: 1,
    })
    await store.upsertCandidate({
      workspaceId,
      candidate: entity({ externalId: 'e:checkout', name: 'Checkout' }),
      signalId: s2,
      extractorVersion: 1,
    })

    // An external-authority service the graph owns, carrying an owner.
    const payments = await store.upsertCandidate({
      workspaceId,
      candidate: entity({
        kind: 'service',
        externalId: 'sdlckg:Service:payments',
        name: 'Payments',
        authority: 'external',
        externalUri: 'sdlckg://Service/payments',
        attributes: { owner: 'Team Pay' },
      }),
      signalId: s1,
      extractorVersion: 1,
    })

    // Checkout depends on it. The edge also makes the external entity itself
    // clear the salience threshold — yet it must still get no page.
    await store.addEdge({
      workspaceId,
      fromEntityId: checkout.entityId,
      toEntityId: payments.entityId,
      kind: 'depends_on',
      confidence: 0.9,
      extractorVersion: 1,
    })

    const outcome = await createWikiCompiler(db.config).compile(workspaceId)

    // The external entity earned no page of its own (AC6).
    expect(await pageFor(payments.entityId), 'no page is generated for an external entity').toBeUndefined()
    expect(outcome.skipped).toBeGreaterThanOrEqual(1)

    // Checkout's page renders it as a link block: name links to the source URI,
    // with its kind and owner, marked external.
    const page = await pageFor(checkout.entityId)
    expect(page, 'the brain entity still earns a page').toBeDefined()
    expect(page!.markdown).toContain('[**Payments**](sdlckg://Service/payments)')
    expect(page!.markdown).toContain('service')
    expect(page!.markdown).toContain('owned by Team Pay')
    expect(page!.markdown).toContain('_(external)_')
  })
})
