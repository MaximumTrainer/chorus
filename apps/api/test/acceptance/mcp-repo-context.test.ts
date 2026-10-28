import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ulid } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type SignedInUser, type TestClient } from '@chorus/testing'

/**
 * MCP-2 AC3 — `get_repo_context` is genuinely useful.
 *
 * What saves an agent from exploring a repository blindly: for one task, the
 * repository it will work in, that repository's conventions (the exact test,
 * lint and build commands), the code the task points at, and the routes those
 * files serve. Read from the same rows the coding brief is built from, so an
 * engineer's agent starts where a sandbox would.
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

interface RepoContext {
  taskId: string
  repository: { fullName: string; baseBranch: string } | null
  conventions: { testCommand: string | null; packageManager: string | null }
  pointers: Array<{ path: string; symbolName: string | null; lineStart: number; lineEnd: number; stale: boolean }>
  routes: Array<{ route: string; component: string; framework: string | null }>
}

describe('MCP-2 AC3 get_repo_context', () => {
  let db: IsolatedDatabase
  let client: TestClient
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
    app = createApp({ dbConfig: db.config, mailer, baseUrl: ISSUER })
    client = createTestClient(app, mailer)
  })

  async function connect(user: SignedInUser, workspaceId: string) {
    const created = await user.post(`/workspaces/${workspaceId}/tokens`, { name: 'agent', scopes: ['read:artefacts'] })
    const token = ((await created.json()) as { token: string }).token
    const transport = new StreamableHTTPClientTransport(
      new URL(`${ISSUER}/workspaces/${workspaceId}/mcp`),
      { fetch: fetchFn, requestInit: { headers: { authorization: `Bearer ${token}` } } },
    )
    const mcp = new Client({ name: 'context-agent', version: '1.0.0' })
    await mcp.connect(asTransport(transport))
    return mcp
  }

  /** A task pointing at an indexed file that serves a route, in a repository with conventions. */
  async function world() {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Context')
    const [team] = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{ id: string }>
    const integrationId = ulid()
    await db.admin.execute(`INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'github')`, [
      integrationId,
      workspace.id,
    ])
    const repoId = ulid()
    await db.admin.execute(
      `INSERT INTO repositories (id, workspace_id, team_id, integration_id, provider, full_name, base_branch, settings)
       VALUES ($1, $2, $3, $4, 'github', 'acme/invoices', 'develop', $5)`,
      [
        repoId,
        workspace.id,
        team!.id,
        integrationId,
        JSON.stringify({ conventions: { packageManager: 'pnpm', testCommand: 'pnpm test' } }),
      ],
    )
    const fileId = ulid()
    await db.admin.execute(
      `INSERT INTO code_files (id, workspace_id, repository_id, path, lang, content_hash)
       VALUES ($1, $2, $3, 'app/invoices/[id]/page.tsx', 'tsx', $4)`,
      [fileId, workspace.id, repoId, ulid()],
    )
    await db.admin.execute(
      `INSERT INTO route_map (id, workspace_id, repository_id, route_pattern, component_file_id, component_path, framework)
       VALUES ($1, $2, $3, '/invoices/:id', $4, 'app/invoices/[id]/page.tsx', 'nextjs')`,
      [ulid(), workspace.id, repoId, fileId],
    )
    // A route elsewhere in the repository, which the task does not touch.
    await db.admin.execute(
      `INSERT INTO route_map (id, workspace_id, repository_id, route_pattern, component_path, framework)
       VALUES ($1, $2, $3, '/settings', 'app/settings/page.tsx', 'nextjs')`,
      [ulid(), workspace.id, repoId],
    )
    const task = (await (
      await ada.post(`/workspaces/${workspace.id}/teams/${team!.id}/tasks`, { title: 'Split an invoice' })
    ).json()) as { id: string }
    await db.admin.execute(
      `INSERT INTO code_pointers (id, workspace_id, task_id, repository_id, path, symbol_name, line_start, line_end, commit_sha, source, confidence)
       VALUES ($1, $2, $3, $4, 'app/invoices/[id]/page.tsx', 'InvoicePage', 10, 42, 'abc123', 'manual', 1)`,
      [ulid(), workspace.id, task.id, repoId],
    )
    return { ada, workspaceId: workspace.id, taskId: task.id }
  }

  it('MCP-2 AC3: get_repo_context gives the repository, its conventions, the pointers and their routes', async () => {
    // Given a task with a code pointer in an indexed repository
    const w = await world()
    const mcp = await connect(w.ada, w.workspaceId)

    // When an agent asks for its repository context
    const result = await mcp.callTool({ name: 'get_repo_context', arguments: { taskId: w.taskId } })

    // Then it has what it needs to start without exploring
    expect((result as ToolResult).isError, textOf(result)).toBeFalsy()
    const context = JSON.parse(textOf(result)) as RepoContext
    expect(context.repository).toMatchObject({ fullName: 'acme/invoices', baseBranch: 'develop' })
    expect(context.conventions).toMatchObject({ packageManager: 'pnpm', testCommand: 'pnpm test' })
    expect(context.pointers).toEqual([
      expect.objectContaining({
        path: 'app/invoices/[id]/page.tsx',
        symbolName: 'InvoicePage',
        lineStart: 10,
        lineEnd: 42,
        stale: false,
      }),
    ])
    // and only the routes the pointed-at code serves
    expect(context.routes).toEqual([
      { route: '/invoices/:id', component: 'app/invoices/[id]/page.tsx', framework: 'nextjs' },
    ])

    // and it is the API's own answer
    const viaApi = await w.ada.get(`/workspaces/${w.workspaceId}/tasks/${w.taskId}/repo-context`)
    expect(viaApi.status, await viaApi.clone().text()).toBe(200)
    expect(context).toEqual(await viaApi.json())
    await mcp.close()
  })

  it("MCP-2 AC3: another workspace's task is answered like a missing one", async () => {
    const w = await world()
    const other = await world()
    const mcp = await connect(w.ada, w.workspaceId)

    const foreign = await mcp.callTool({ name: 'get_repo_context', arguments: { taskId: other.taskId } })
    const missing = await mcp.callTool({ name: 'get_repo_context', arguments: { taskId: 'no-such-task' } })

    expect((foreign as ToolResult).isError).toBe(true)
    expect(textOf(foreign).replace(other.taskId, 'ID')).toBe(textOf(missing).replace('no-such-task', 'ID'))
    await mcp.close()
  })
})
