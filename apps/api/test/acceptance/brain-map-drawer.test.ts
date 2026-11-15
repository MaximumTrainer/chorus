import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ulid, type EntityCandidate } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createEntityStore } from '@chorus/brain'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type SignedInUser, type TestClient } from '@chorus/testing'

/**
 * BRAIN-6 AC4 — the entity drawer, and BRAIN-11 AC7.
 *
 * Selecting a node opens a drawer with everything needed to judge it: for a
 * brain entity its compiled page, for an external-authority entity the source
 * it is authoritative in and an outbound link instead of a page, the evidence
 * behind it, and the artefacts it links to — each resolving. The drawer is not
 * an exemption from the permission rules either: an entity the caller may not
 * see is not found.
 */
interface Drawer {
  id: string
  name: string
  authority: 'brain' | 'external'
  externalUri: string | null
  page: string | null
  authoritativeIn: string | null
  evidence: Array<{ signalId: string; source: string; url: string | null; excerpt: string }>
  relatedArtefacts: Array<{ type: string; id: string; relation: string }>
}

describe('BRAIN-6 the entity drawer', () => {
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
    const workspace = await ada.createWorkspace('Drawered')
    const integrationId = ulid()
    await db.admin.execute(`INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'confluence')`, [
      integrationId,
      workspace.id,
    ])
    return { ada, workspaceId: workspace.id, integrationId }
  }

  async function signal(
    w: Awaited<ReturnType<typeof world>>,
    input: { source: string; permissions: unknown; url?: string; text?: string },
  ): Promise<string> {
    const id = ulid()
    await db.admin.execute(
      `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, url, permissions)
       VALUES ($1, $2, $3, $4, $1, 'page', $5, now(), $6, $7::jsonb)`,
      [id, w.workspaceId, w.integrationId, input.source, input.text ?? 'evidence text', input.url ?? null, JSON.stringify(input.permissions)],
    )
    return id
  }

  function drawer(user: SignedInUser, workspaceId: string, entityId: string) {
    return user.get(`/workspaces/${workspaceId}/brain/map/entities/${entityId}`)
  }

  it('BRAIN-6 AC4: a brain entity drawer shows its page, evidence and related artefacts', async () => {
    const w = await world()
    const store = createEntityStore(db.config)
    const sig = await signal(w, { source: 'confluence', permissions: { visibility: 'public', scopeIds: [] }, url: 'https://wiki.test/p/1' })
    const checkout = await store.upsertCandidate({
      workspaceId: w.workspaceId,
      candidate: candidate({ externalId: 'e:checkout', name: 'checkout' }),
      signalId: sig,
      extractorVersion: 1,
    })
    // A compiled wiki page for it.
    await db.admin.execute(
      `INSERT INTO wiki_pages (id, workspace_id, entity_id, slug, kind, markdown, content_hash, compiled_at)
       VALUES ($1, $2, $3, 'checkout', 'feature', '# Checkout', 'h1', now())`,
      [ulid(), w.workspaceId, checkout.entityId],
    )
    // A task that links to it.
    await db.admin.execute(
      `INSERT INTO artefact_links (id, workspace_id, from_type, from_id, to_type, to_id, relation)
       VALUES ($1, $2, 'task', $3, 'entity', $4, 'relates_to')`,
      [ulid(), w.workspaceId, 'task_123', checkout.entityId],
    )

    const res = await drawer(w.ada, w.workspaceId, checkout.entityId)
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as Drawer
    expect(body).toMatchObject({ authority: 'brain', externalUri: null, page: '# Checkout', authoritativeIn: null })
    expect(body.evidence).toHaveLength(1)
    expect(body.evidence[0]).toMatchObject({ signalId: sig, source: 'confluence', url: 'https://wiki.test/p/1' })
    expect(body.relatedArtefacts).toEqual([{ type: 'task', id: 'task_123', relation: 'relates_to' }])
  })

  it('BRAIN-6 AC4 / BRAIN-11 AC7: an external entity drawer shows its source, not a page', async () => {
    const w = await world()
    const store = createEntityStore(db.config)
    const sig = await signal(w, { source: 'confluence', permissions: { visibility: 'public', scopeIds: [] } })
    const payments = await store.upsertCandidate({
      workspaceId: w.workspaceId,
      candidate: candidate({
        kind: 'service',
        externalId: 'sdlckg:Service:payments',
        name: 'payments',
        authority: 'external',
        externalUri: 'sdlckg://Service/payments',
      }),
      signalId: sig,
      extractorVersion: 1,
    })

    const res = await drawer(w.ada, w.workspaceId, payments.entityId)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Drawer
    expect(body).toMatchObject({
      authority: 'external',
      externalUri: 'sdlckg://Service/payments',
      page: null,
      authoritativeIn: 'confluence',
    })
  })

  it('BRAIN-6 AC6: the drawer of an entity the caller may not see is not found', async () => {
    const w = await world()
    const store = createEntityStore(db.config)
    const restricted = await signal(w, {
      source: 'confluence',
      permissions: { visibility: 'restricted', scopeIds: ['confluence:group:finance'] },
    })
    const secret = await store.upsertCandidate({
      workspaceId: w.workspaceId,
      candidate: candidate({ externalId: 'e:secret', name: 'secret' }),
      signalId: restricted,
      extractorVersion: 1,
    })

    const res = await drawer(w.ada, w.workspaceId, secret.entityId)
    expect(res.status).toBe(404)
  })
})
