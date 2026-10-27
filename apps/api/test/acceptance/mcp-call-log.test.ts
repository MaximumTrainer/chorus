import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type SignedInUser, type TestClient } from '@chorus/testing'

/**
 * MCP-5 AC3 and AC5 — every call is attributed, and revocation is immediate.
 *
 * An MCP session is recorded as a run, and each tool call as a `tool_call`
 * event on it carrying the client's name, the person the agent acts for, the
 * tool, the outcome and how long it took. So "what did my agent do" is read
 * from the same trace as any workflow's. The client name comes from the
 * client and is logged, never trusted for anything.
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

interface Trace {
  workflowName: string
  startedBy: string
  events: Array<{ kind: string; payload: Record<string, unknown> }>
}

describe('MCP-5 call log and revocation', () => {
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

  async function world(clientName = 'logging-agent') {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Attributed')
    const [team] = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{ id: string }>
    const created = await ada.post(`/workspaces/${workspace.id}/tokens`, {
      name: 'agent',
      scopes: ['read:artefacts', 'write:artefacts'],
    })
    const issued = (await created.json()) as { id: string; token: string }
    const transport = new StreamableHTTPClientTransport(
      new URL(`${ISSUER}/workspaces/${workspace.id}/mcp`),
      { fetch: fetchFn, requestInit: { headers: { authorization: `Bearer ${issued.token}` } } },
    )
    const mcp = new Client({ name: clientName, version: '1.0.0' })
    await mcp.connect(asTransport(transport))
    return { ada, workspaceId: workspace.id, teamId: team!.id, tokenId: issued.id, mcp }
  }

  async function sessionTrace(user: SignedInUser, workspaceId: string): Promise<Trace> {
    const [run] = await db.admin.query<{ id: string }>(
      `SELECT id FROM runs WHERE workspace_id = $1 AND workflow_name = 'mcp-session'`,
      [workspaceId],
    )
    expect(run, 'the MCP session was not recorded as a run').toBeDefined()
    const response = await user.get(`/workspaces/${workspaceId}/runs/${run!.id}/trace`)
    expect(response.status, await response.clone().text()).toBe(200)
    return (await response.json()) as Trace
  }

  it('MCP-5 AC3: every call is logged with the client, the user, the tool, the outcome and the duration', async () => {
    // Given an agent connected as "logging-agent"
    const w = await world('logging-agent')

    // When it makes one call that works and one that does not
    await w.mcp.callTool({ name: 'create_task', arguments: { teamId: w.teamId, title: 'Logged' } })
    await w.mcp.callTool({ name: 'get_task', arguments: { taskId: 'no-such-task' } })

    // Then the session's trace records both, attributed to Ada and the client
    const trace = await sessionTrace(w.ada, w.workspaceId)
    expect(trace.startedBy).toBe(w.ada.userId)
    const calls = trace.events.filter((event) => event.kind === 'tool_call').map((event) => event.payload)
    expect(calls).toEqual([
      expect.objectContaining({ client: 'logging-agent', userId: w.ada.userId, tool: 'create_task', outcome: 'ok' }),
      expect.objectContaining({ client: 'logging-agent', userId: w.ada.userId, tool: 'get_task', outcome: 'error' }),
    ])
    for (const call of calls) expect(call.durationMs).toEqual(expect.any(Number))
    await w.mcp.close()
  })

  it('MCP-5 AC3: a call to a tool that does not exist is logged too', async () => {
    const w = await world()

    await w.mcp.callTool({ name: 'delete_everything', arguments: {} })

    const calls = (await sessionTrace(w.ada, w.workspaceId)).events.filter((event) => event.kind === 'tool_call')
    expect(calls.map((event) => event.payload)).toEqual([
      expect.objectContaining({ tool: 'delete_everything', outcome: 'error' }),
    ])
    await w.mcp.close()
  })

  it('MCP-5 AC5: revoking a token refuses the next call in an open session', async () => {
    // Given an agent mid-session
    const w = await world()
    const before = await w.mcp.callTool({ name: 'list_tasks', arguments: { teamId: w.teamId } })
    expect((before as ToolResult).isError, textOf(before)).toBeFalsy()

    // When its token is revoked
    const revoked = await w.ada.delete(`/workspaces/${w.workspaceId}/tokens/${w.tokenId}`)
    expect(revoked.status, await revoked.clone().text()).toBeLessThan(300)

    // Then its very next call is refused, with no cached window
    const after = await w.mcp
      .callTool({ name: 'list_tasks', arguments: { teamId: w.teamId } })
      .catch((error: Error) => error)
    const refused =
      after instanceof Error ? after.message : (after as ToolResult).isError ? textOf(after) : 'not refused'
    expect(refused).toMatch(/401|authenticat|revoked|Unauthorized/i)
  })
})
