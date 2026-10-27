import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ulid } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createRetriever } from '@chorus/brain'
import { createApp } from '../../src/app.js'
import {
  createFakeModelProvider,
  createRecordingMailer,
  createTestClient,
  type FakeModelProvider,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * BRAIN-4 — retrieval, reachable over the API.
 *
 * The one retrieval function, served by one route, so that MCP's `search`
 * tool, global search (NAV-1) and a script all get the same ranking and the
 * same permission predicate the agents do. The route adds nothing to what is
 * retrieved: the predicate is inside the query (AC2), the bundle is persisted
 * so its citations can be resolved later (AC4), and a query that matches
 * nothing comes back empty rather than padded (AC6).
 */

interface Bundle {
  id: string
  query: string
  considered: number
  fragments: Array<{ citationId: string; path: string; text: string }>
}

describe('BRAIN-4 the search route', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let models: FakeModelProvider

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    models = createFakeModelProvider()
    const retriever = createRetriever(db.config, {
      models,
      embeddingModel: { provider: 'fake', model: 'fake-embed' },
    })
    client = createTestClient(createApp({ dbConfig: db.config, mailer, retriever }), mailer)
  })

  /**
   * Ada's workspace, with a second team, Billing, whose repository holds the
   * invoice code. Grace is in the workspace but not in Billing.
   */
  async function world() {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Searchable')
    const [defaultTeam] = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    const created = await ada.post(`/workspaces/${workspace.id}/teams`, { name: 'Billing' })
    expect(created.status, await created.clone().text()).toBe(201)
    const billing = (await created.json()) as { id: string }

    const integrationId = ulid()
    await db.admin.execute(
      `INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'github')`,
      [integrationId, workspace.id],
    )
    const repoId = ulid()
    await db.admin.execute(
      `INSERT INTO repositories (id, workspace_id, team_id, integration_id, provider, full_name)
       VALUES ($1, $2, $3, $4, 'github', $5)`,
      [repoId, workspace.id, billing.id, integrationId, `acme/invoices-${repoId.slice(-6)}`],
    )

    const grace = await client.memberWithRole(ada, workspace.id, 'member')
    return { ada, grace, workspaceId: workspace.id, defaultTeamId: defaultTeam!.id, billingId: billing.id, repoId }
  }

  async function addChunk(w: Awaited<ReturnType<typeof world>>, path: string, text: string) {
    const fileId = ulid()
    await db.admin.execute(
      `INSERT INTO code_files (id, workspace_id, repository_id, path, lang, content_hash)
       VALUES ($1, $2, $3, $4, 'ts', $5)`,
      [fileId, w.workspaceId, w.repoId, path, ulid()],
    )
    await db.admin.execute(
      `INSERT INTO code_chunks
         (id, workspace_id, repository_id, file_id, text, line_start, line_end, symbol_name, embedding)
       VALUES ($1, $2, $3, $4, $5, 1, 20, 'parseInvoice', $6::vector)`,
      [ulid(), w.workspaceId, w.repoId, fileId, text, `[${models.embedText(text).join(',')}]`],
    )
  }

  async function search(user: SignedInUser, workspaceId: string, teamId: string, body: unknown) {
    return user.post(`/workspaces/${workspaceId}/teams/${teamId}/search`, body)
  }

  it('BRAIN-4: a search returns cited fragments, and the bundle can be read back by its id', async () => {
    // Given Billing's indexed code
    const w = await world()
    await addChunk(w, 'src/invoice.ts', 'export function parseInvoice(payment) { return settle(payment) }')

    // When Ada searches for it
    const response = await search(w.ada, w.workspaceId, w.billingId, { query: 'parseInvoice' })

    // Then the fragment is cited
    expect(response.status, await response.clone().text()).toBe(200)
    const bundle = (await response.json()) as Bundle
    expect(bundle.fragments.map((fragment) => fragment.path)).toEqual(['src/invoice.ts'])
    expect(bundle.fragments[0]!.citationId).toEqual(expect.any(String))
    // and the bundle was kept, so its citations resolve to the same fragments later
    const stored = await w.ada.get(`/workspaces/${w.workspaceId}/context-bundles/${bundle.id}`)
    expect(stored.status, await stored.clone().text()).toBe(200)
    expect(((await stored.json()) as Bundle).fragments).toEqual(bundle.fragments)
  })

  it('BRAIN-4: code in a team the caller is not in is absent, and not even counted', async () => {
    // Given Billing's code, and Grace, who is not in Billing
    const w = await world()
    await addChunk(w, 'src/invoice.ts', 'export function parseInvoice(payment) { return settle(payment) }')

    // When Grace searches for it from her own team
    const response = await search(w.grace, w.workspaceId, w.defaultTeamId, { query: 'parseInvoice' })

    // Then nothing comes back, and the count does not betray that something was hidden
    expect(response.status, await response.clone().text()).toBe(200)
    expect((await response.json()) as Bundle).toMatchObject({ fragments: [], considered: 0 })
  })

  it('BRAIN-4: a query matching nothing returns an empty bundle, not filler', async () => {
    const w = await world()
    await addChunk(w, 'src/invoice.ts', 'export function parseInvoice(payment) { return settle(payment) }')

    const response = await search(w.ada, w.workspaceId, w.billingId, {
      query: 'kubernetes helm chart ingress',
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(((await response.json()) as Bundle).fragments).toEqual([])
  })

  it('BRAIN-4: a malformed search is refused, naming the field', async () => {
    const w = await world()

    const empty = await search(w.ada, w.workspaceId, w.billingId, { query: '' })
    const tooMany = await search(w.ada, w.workspaceId, w.billingId, { query: 'x', k: 1000 })

    expect(empty.status).toBe(400)
    expect(((await empty.json()) as { detail: string }).detail).toContain('query')
    expect(tooMany.status).toBe(400)
    expect(((await tooMany.json()) as { detail: string }).detail).toContain('k')
  })

  it('BRAIN-4: a token without read:brain is refused', async () => {
    const w = await world()
    const created = await w.ada.post(`/workspaces/${w.workspaceId}/tokens`, {
      name: 'narrow',
      scopes: ['read:artefacts'],
    })
    const token = ((await created.json()) as { token: string }).token

    const response = await client
      .bearer(token)
      .post(`/workspaces/${w.workspaceId}/teams/${w.billingId}/search`, { query: 'parseInvoice' })

    expect(response.status).toBe(403)
    expect(((await response.json()) as { detail: string }).detail).toContain('read:brain')
  })
})
