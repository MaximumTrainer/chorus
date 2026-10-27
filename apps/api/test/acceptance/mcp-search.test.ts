import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
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
 * MCP-2 `search`, and MCP-5 AC2 — retrieval over MCP is retrieval.
 *
 * The tool is answered by the BRAIN-4 search route, so an agent gets the same
 * fragments a person would, and content hidden from a person in the product is
 * hidden from their agent too: there is no second predicate to disagree.
 */

const ISSUER = 'http://localhost:3000'

function asTransport(transport: StreamableHTTPClientTransport): Transport {
  return transport as unknown as Transport
}

interface ToolResult {
  readonly isError?: boolean
  readonly content: ReadonlyArray<{ type: string; text?: string }>
}

function textOf(result: unknown): string {
  return (result as ToolResult).content.map((part) => part.text ?? '').join('')
}

interface Bundle {
  id: string
  considered: number
  fragments: Array<{ citationId: string; path: string }>
}

describe('MCP-2 search and MCP-5 AC2', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let models: FakeModelProvider
  let app: ReturnType<typeof createApp>

  const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = new URL(url.toString())
    return app.request(`${target.pathname}${target.search}`, init)
  }

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
    app = createApp({ dbConfig: db.config, mailer, baseUrl: ISSUER, retriever })
    client = createTestClient(app, mailer)
  })

  async function connect(user: SignedInUser, workspaceId: string) {
    const created = await user.post(`/workspaces/${workspaceId}/tokens`, {
      name: 'agent',
      scopes: ['read:artefacts', 'read:brain'],
    })
    const token = ((await created.json()) as { token: string }).token
    const transport = new StreamableHTTPClientTransport(
      new URL(`${ISSUER}/workspaces/${workspaceId}/mcp`),
      { fetch: fetchFn, requestInit: { headers: { authorization: `Bearer ${token}` } } },
    )
    const mcp = new Client({ name: 'search-agent', version: '1.0.0' })
    await mcp.connect(asTransport(transport))
    return mcp
  }

  /** Billing's indexed code, Ada in Billing, Grace in the workspace but not in Billing. */
  async function world() {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Searchable over MCP')
    const [defaultTeam] = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    const billing = (await (await ada.post(`/workspaces/${workspace.id}/teams`, { name: 'Billing' })).json()) as {
      id: string
    }
    await ada.put(`/workspaces/${workspace.id}/teams/${billing.id}/members/${ada.userId}`, {})

    const integrationId = ulid()
    await db.admin.execute(`INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'github')`, [
      integrationId,
      workspace.id,
    ])
    const repoId = ulid()
    await db.admin.execute(
      `INSERT INTO repositories (id, workspace_id, team_id, integration_id, provider, full_name)
       VALUES ($1, $2, $3, $4, 'github', $5)`,
      [repoId, workspace.id, billing.id, integrationId, `acme/invoices-${repoId.slice(-6)}`],
    )
    const text = 'export function parseInvoice(payment) { return settle(payment) }'
    const fileId = ulid()
    await db.admin.execute(
      `INSERT INTO code_files (id, workspace_id, repository_id, path, lang, content_hash)
       VALUES ($1, $2, $3, 'src/invoice.ts', 'ts', $4)`,
      [fileId, workspace.id, repoId, ulid()],
    )
    await db.admin.execute(
      `INSERT INTO code_chunks
         (id, workspace_id, repository_id, file_id, text, line_start, line_end, symbol_name, embedding)
       VALUES ($1, $2, $3, $4, $5, 1, 20, 'parseInvoice', $6::vector)`,
      [ulid(), workspace.id, repoId, fileId, text, `[${models.embedText(text).join(',')}]`],
    )

    const grace = await client.memberWithRole(ada, workspace.id, 'member')
    return { ada, grace, workspaceId: workspace.id, defaultTeamId: defaultTeam!.id, billingId: billing.id }
  }

  it('MCP-2: search over MCP returns the fragments the search route does', async () => {
    const w = await world()
    const mcp = await connect(w.ada, w.workspaceId)

    const result = await mcp.callTool({ name: 'search', arguments: { teamId: w.billingId, query: 'parseInvoice' } })

    expect((result as ToolResult).isError, textOf(result)).toBeFalsy()
    const viaMcp = JSON.parse(textOf(result)) as Bundle
    const viaApi = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.billingId}/search`, { query: 'parseInvoice' })
    ).json()) as Bundle
    expect(viaMcp.fragments.map((fragment) => fragment.citationId)).toEqual(
      viaApi.fragments.map((fragment) => fragment.citationId),
    )
    expect(viaMcp.fragments.map((fragment) => fragment.path)).toEqual(['src/invoice.ts'])
    await mcp.close()
  })

  it('MCP-5 AC2: content hidden in the web UI is equally hidden through MCP search', async () => {
    // Given code Grace cannot see in the product
    const w = await world()
    const inProduct = (await (
      await w.grace.post(`/workspaces/${w.workspaceId}/teams/${w.defaultTeamId}/search`, { query: 'parseInvoice' })
    ).json()) as Bundle
    expect(inProduct).toMatchObject({ fragments: [], considered: 0 })

    // When her agent searches for it
    const mcp = await connect(w.grace, w.workspaceId)
    const result = await mcp.callTool({ name: 'search', arguments: { teamId: w.defaultTeamId, query: 'parseInvoice' } })

    // Then it is absent there too, and uncounted
    expect((result as ToolResult).isError, textOf(result)).toBeFalsy()
    expect(JSON.parse(textOf(result)) as Bundle).toMatchObject({ fragments: [], considered: 0 })
    await mcp.close()
  })
})
