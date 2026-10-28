import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type SignedInUser, type TestClient } from '@chorus/testing'

/**
 * MCP-5 AC4 — rate limiting is per client.
 *
 * An agent in a loop can call a tool hundreds of times a minute, and every
 * call is an API request made as a person. The limit is per credential, so
 * one runaway agent is throttled while the same person's other client, and
 * everybody else's, carries on. A throttled call is told how long to wait.
 * The clock is injected, so recovery is tested without sleeping.
 */

const ISSUER = 'http://localhost:3000'

function asTransport(transport: StreamableHTTPClientTransport): Transport {
  return transport as unknown as Transport
}

interface ToolResult {
  readonly isError?: boolean
}

describe('MCP-5 AC4 per-client rate limiting', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let app: ReturnType<typeof createApp>
  let clock: number

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
    clock = 1_000_000
    const mailer = createRecordingMailer()
    app = createApp({
      dbConfig: db.config,
      mailer,
      baseUrl: ISSUER,
      mcp: { now: () => clock, rateLimit: { burst: 3, perMinute: 60 } },
    })
    client = createTestClient(app, mailer)
  })

  async function agent(user: SignedInUser, workspaceId: string, name: string) {
    const created = await user.post(`/workspaces/${workspaceId}/tokens`, { name, scopes: ['read:artefacts'] })
    const token = ((await created.json()) as { token: string }).token
    const transport = new StreamableHTTPClientTransport(
      new URL(`${ISSUER}/workspaces/${workspaceId}/mcp`),
      { fetch: fetchFn, requestInit: { headers: { authorization: `Bearer ${token}` } } },
    )
    const mcp = new Client({ name, version: '1.0.0' })
    await mcp.connect(asTransport(transport))
    return mcp
  }

  async function world() {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Throttled')
    const [team] = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{ id: string }>
    return { ada, workspaceId: workspace.id, teamId: team!.id }
  }

  it('MCP-5 AC4: a client past its limit is throttled with a retry-after, and other clients are unaffected', async () => {
    // Given two agents of Ada's, each with its own token
    const w = await world()
    const runaway = await agent(w.ada, w.workspaceId, 'runaway')
    const steady = await agent(w.ada, w.workspaceId, 'steady')
    const call = { name: 'list_tasks', arguments: { teamId: w.teamId } }

    // When one spends its whole burst and calls again
    for (let i = 0; i < 3; i++) {
      expect(((await runaway.callTool(call)) as ToolResult).isError).toBeFalsy()
    }
    const throttled = await runaway.callTool(call).catch((error: Error) => error)

    // Then it is refused with how long to wait
    expect(throttled).toBeInstanceOf(Error)
    expect((throttled as Error).message).toMatch(/rate limit/i)
    expect((throttled as Error).message).toMatch(/retry after 1 second/i)

    // and the other client is not
    expect(((await steady.callTool(call)) as ToolResult).isError).toBeFalsy()

    await runaway.close().catch(() => undefined)
    await steady.close()
  })

  it('MCP-5 AC4: a throttled client may call again once the wait has passed', async () => {
    const w = await world()
    const runaway = await agent(w.ada, w.workspaceId, 'runaway')
    const call = { name: 'list_tasks', arguments: { teamId: w.teamId } }
    for (let i = 0; i < 3; i++) await runaway.callTool(call)
    await expect(runaway.callTool(call)).rejects.toThrow(/rate limit/i)

    // When a second passes, one call's worth comes back
    clock += 1_000

    expect(((await runaway.callTool(call)) as ToolResult).isError).toBeFalsy()
    await expect(runaway.callTool(call)).rejects.toThrow(/rate limit/i)
    await runaway.close().catch(() => undefined)
  })

  it('MCP-5 AC4: listing tools and initialising do not use up the limit', async () => {
    const w = await world()
    const runaway = await agent(w.ada, w.workspaceId, 'runaway')

    for (let i = 0; i < 5; i++) await runaway.listTools()

    expect(
      ((await runaway.callTool({ name: 'list_tasks', arguments: { teamId: w.teamId } })) as ToolResult).isError,
    ).toBeFalsy()
    await runaway.close()
  })
})
