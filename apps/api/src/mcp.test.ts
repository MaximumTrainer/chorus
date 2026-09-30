import { describe, it, expect } from 'vitest'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { createMcpEndpoint, type McpCaller } from './mcp.js'

/**
 * MCP-1 AC5 — who owns a session, apart from how the caller was authenticated.
 *
 * The acceptance suite proves this through the routes. This pins the rule
 * itself: a session belongs to the user *and* the workspace it was opened in,
 * and a session nobody has used for the idle timeout is gone.
 */
describe('MCP-1 session ownership', () => {
  const ada: McpCaller = { userId: 'ada', workspaceId: 'w-1' }

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
    })

  // A function, not a value: a Request's body can be read once.
  const initialize = () => post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'unit', version: '1' },
    },
  })

  const listTools = (sessionId: string) =>
    post(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'mcp-session-id': sessionId, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
    )

  async function opened(endpoint: ReturnType<typeof createMcpEndpoint>): Promise<string> {
    const response = await endpoint.handle(initialize(), ada)
    expect(response.status).toBe(200)
    const id = response.headers.get('mcp-session-id')
    expect(id).toBeTruthy()
    return id!
  }

  it('MCP-1 AC5: the session answers the caller who opened it', async () => {
    const endpoint = createMcpEndpoint()
    const id = await opened(endpoint)

    const response = await endpoint.handle(listTools(id), ada)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ result: { tools: expect.any(Array) } })
  })

  it('MCP-1 AC5: the same user in another workspace does not reach it', async () => {
    const endpoint = createMcpEndpoint()
    const id = await opened(endpoint)

    const response = await endpoint.handle(listTools(id), { ...ada, workspaceId: 'w-2' })

    expect(response.status).toBe(404)
  })

  it('MCP-1 AC5: a session idle past the timeout is closed, and one used within it is not', async () => {
    let clock = 0
    const endpoint = createMcpEndpoint({ idleTimeoutMs: 1_000, now: () => clock })
    const id = await opened(endpoint)

    clock = 999
    expect((await endpoint.handle(listTools(id), ada)).status).toBe(200)

    // Idle measured from the last use, not from when it was opened.
    clock = 1_998
    expect((await endpoint.handle(listTools(id), ada)).status).toBe(200)

    clock = 3_000
    expect((await endpoint.handle(listTools(id), ada)).status).toBe(404)
  })

  it('MCP-1: no server stream is offered yet, and a client is told so', async () => {
    const endpoint = createMcpEndpoint()

    const response = await endpoint.handle(
      new Request('http://localhost/mcp', { method: 'GET', headers: { accept: 'text/event-stream' } }),
      ada,
    )

    expect(response.status).toBe(405)
  })
})
