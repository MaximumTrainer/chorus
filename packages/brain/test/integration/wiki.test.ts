import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid, type EntityCandidate } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createEntityStore, createWikiCompiler } from '../../src/index.js'

/**
 * BRAIN-5 — wiki compilation.
 *
 * A salient entity compiles to a page whose every related and evidence line is
 * backed by a real edge or signal (AC1, AC2). A below-threshold entity gets no
 * page. Compilation is incremental: an unchanged entity's page is not rewritten
 * on the next run (AC3).
 */
describe('BRAIN-5 wiki compilation', () => {
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
    const [row] = await db.admin.query<{ slug: string; markdown: string; compiled_at: Date }>(
      `SELECT slug, markdown, compiled_at FROM wiki_pages WHERE entity_id = $1`,
      [entityId],
    )
    return row
  }

  it('BRAIN-5 AC1/AC2: a salient entity compiles to an evidenced page; a thin one does not', async () => {
    const { workspaceId, integrationId, store } = await setup()

    // Salient: two evidence signals and an edge clear the threshold.
    const s1 = await signal(workspaceId, integrationId, 'ACME-1')
    const s2 = await signal(workspaceId, integrationId, 'ACME-2')
    const salient = await store.upsertCandidate({
      workspaceId,
      candidate: entity({ externalId: 'e:billing', name: 'Billing Service' }),
      signalId: s1,
      extractorVersion: 1,
    })
    await store.upsertCandidate({
      workspaceId,
      candidate: entity({ externalId: 'e:billing', name: 'Billing Service' }),
      signalId: s2,
      extractorVersion: 1,
    })
    const other = await store.upsertCandidate({
      workspaceId,
      candidate: entity({ externalId: 'e:checkout', name: 'Checkout', kind: 'component' }),
      signalId: s1,
      extractorVersion: 1,
    })
    await store.addEdge({
      workspaceId,
      fromEntityId: salient.entityId,
      toEntityId: other.entityId,
      kind: 'depends_on',
      confidence: 0.9,
      extractorVersion: 1,
    })

    // Thin: one evidence signal, no edges — below the threshold.
    const thin = await store.upsertCandidate({
      workspaceId,
      candidate: entity({ externalId: 'e:thin', name: 'Lonely Thing' }),
      signalId: await signal(workspaceId, integrationId, 'ACME-9'),
      extractorVersion: 1,
    })

    const outcome = await createWikiCompiler(db.config).compile(workspaceId)
    expect(outcome.compiled).toBeGreaterThanOrEqual(1)

    const page = await pageFor(salient.entityId)
    expect(page?.slug).toBe('billing-service')
    // Every evidence line resolves to a signal the page cites (AC2).
    expect(page?.markdown).toContain('https://x.test/ACME-1')
    expect(page?.markdown).toContain(`entityId: ${salient.entityId}`)

    // The thin entity earned no page (AC1).
    expect(await pageFor(thin.entityId)).toBeUndefined()
  })

  it('BRAIN-5 AC3: an unchanged entity is not rewritten on the next compile', async () => {
    const { workspaceId, integrationId, store } = await setup()
    const s1 = await signal(workspaceId, integrationId, 'ACME-1')
    const s2 = await signal(workspaceId, integrationId, 'ACME-2')
    const e = await store.upsertCandidate({
      workspaceId,
      candidate: entity({ externalId: 'e:x', name: 'Thing' }),
      signalId: s1,
      extractorVersion: 1,
    })
    await store.upsertCandidate({
      workspaceId,
      candidate: entity({ externalId: 'e:x', name: 'Thing' }),
      signalId: s2,
      extractorVersion: 1,
    })

    await createWikiCompiler(db.config).compile(workspaceId)
    const first = await pageFor(e.entityId)

    const second = await createWikiCompiler(db.config).compile(workspaceId)
    expect(second.compiled).toBe(0)
    expect(second.skipped).toBeGreaterThanOrEqual(1)
    const after = await pageFor(e.entityId)
    expect(after?.compiled_at.toISOString()).toBe(first?.compiled_at.toISOString())
  })
})
