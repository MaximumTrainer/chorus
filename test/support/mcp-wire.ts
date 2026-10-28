/**
 * A minimal MCP client over Streamable HTTP, for suites outside `apps/api`.
 *
 * The NFR suites run from the repository root, which does not depend on the
 * MCP SDK, and adding it there to drive four JSON-RPC calls would be a second
 * copy of a dependency for no behaviour. The server is the SDK's, so what this
 * speaks is checked against the real thing on every run: initialise, confirm,
 * then call.
 */

export interface McpWire {
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>
}

export interface McpToolResult {
  readonly isError?: boolean
  readonly content: ReadonlyArray<{ type: string; text?: string }>
}

type Send = (path: string, init: RequestInit) => Promise<Response>

export async function connectMcp(
  send: Send,
  workspaceId: string,
  headers: Record<string, string>,
  clientName = 'nfr-suite',
): Promise<McpWire> {
  const path = `/workspaces/${workspaceId}/mcp`
  const base = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...headers,
  }
  let id = 0
  const post = (body: unknown, extra: Record<string, string> = {}) =>
    send(path, { method: 'POST', headers: { ...base, ...extra }, body: JSON.stringify(body) })

  const initialised = await post({
    jsonrpc: '2.0',
    id: ++id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: clientName, version: '1.0.0' },
    },
  })
  if (initialised.status !== 200) {
    throw new Error(`MCP initialise failed: ${initialised.status} ${await initialised.text()}`)
  }
  const session = initialised.headers.get('mcp-session-id')
  if (!session) throw new Error('MCP initialise returned no session id')
  const version =
    ((await initialised.json()) as { result?: { protocolVersion?: string } }).result
      ?.protocolVersion ?? '2025-06-18'
  const sessionHeaders = { 'mcp-session-id': session, 'mcp-protocol-version': version }
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionHeaders)

  return {
    async callTool(name, args) {
      const response = await post(
        { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } },
        sessionHeaders,
      )
      const body = (await response.json()) as {
        result?: McpToolResult
        error?: { message: string }
      }
      if (!body.result) throw new Error(`tools/call ${name} failed: ${JSON.stringify(body.error ?? body)}`)
      return body.result
    },
  }
}

export function textOf(result: McpToolResult): string {
  return result.content.map((part) => part.text ?? '').join('')
}
