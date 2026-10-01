import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { callTool, toolList } from './mcp-tools.js'

/**
 * The MCP endpoint's sessions (MCP-1, architecture.md §14).
 *
 * The transport and the protocol are the SDK's: version negotiation, JSON-RPC
 * framing and the header rules are exactly the parts a hand-written server
 * would get subtly wrong, and a client library would then disagree with it in
 * ways no test written against our own reading of the specification could see.
 *
 * What is ours is *who owns a session*. The SDK knows a session id; it does not
 * know a user or a workspace. A session is therefore bound to both at
 * initialisation, and a request presenting that id with any other identity is
 * answered as if the session did not exist (AC5) — "not found" rather than
 * "forbidden", because confirming that an id is live is itself a leak.
 */

export interface McpEndpointOptions {
  /**
   * How long a session may sit unused before it is closed (AC5).
   *
   * Thirty minutes by default: an agent working on a task goes quiet while it
   * edits and runs tests, and a session that expired mid-task would force a
   * re-initialisation at the worst moment. Long enough for that, short enough
   * that an abandoned session is not held for a day.
   */
  readonly idleTimeoutMs?: number
  /** Injected so expiry is testable without waiting (CLAUDE.md §5). */
  readonly now?: () => number
  /**
   * The most characters one tool result may carry (MCP-2 AC2).
   *
   * About 12,000 tokens by default: enough for a long task or a whole PRD
   * section by section, small enough that one call cannot fill an agent's
   * context window with a single answer.
   */
  readonly maxResultChars?: number
}

/** Who a request is from, once the route has authorised it. */
export interface McpCaller {
  readonly userId: string
  readonly workspaceId: string
}

export interface McpEndpoint {
  handle(request: Request, caller: McpCaller): Promise<Response>
}

interface Session {
  readonly transport: WebStandardStreamableHTTPServerTransport
  readonly caller: McpCaller
  lastSeen: number
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_MAX_RESULT_CHARS = 48_000

/** What a session's tools need to answer: whose workspace, and how to reach the API. */
interface ToolEnvironment {
  readonly workspaceId: string
  readonly origin: string
  readonly dispatch: (request: Request) => Promise<Response>
  readonly maxResultChars: number
}

/** The headers of the request a call arrived on, as a `Headers`. */
function headersOf(raw: Record<string, string | string[] | undefined> | undefined): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) for (const each of value) headers.append(name, each)
  }
  return headers
}

/**
 * The protocol server one session talks to.
 *
 * A tool call is authorised afresh with the credential on the request that
 * carries it, not the one that opened the session: a token revoked mid-session
 * stops working at its next call rather than when the session expires
 * (MCP-5 AC5).
 */
function protocolServer(environment: ToolEnvironment): Server {
  const server = new Server(
    { name: 'chorus', version: '0.0.0' },
    { capabilities: { tools: { listChanged: false } } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await callTool(request.params.name, request.params.arguments, {
      ...environment,
      credentials: headersOf(extra.requestInfo?.headers),
    })
    if (result) return result
    return {
      content: [
        {
          type: 'text' as const,
          text: `There is no tool called ${request.params.name}. Call tools/list to see the tools this server offers.`,
        },
      ],
      isError: true,
    }
  })
  return server
}

/** A JSON-RPC error body, the shape a client reads when a session is gone. */
function sessionNotFound(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found. Initialize a new session.' },
      id: null,
    }),
    { status: 404, headers: { 'content-type': 'application/json' } },
  )
}

export function createMcpEndpoint(
  options: McpEndpointOptions = {},
  /** Hands a tool's read to the API route that serves it (ADR-0021). */
  dispatch: (request: Request) => Promise<Response> = () => {
    throw new Error('MCP tools need the app to dispatch through; this endpoint was built without one')
  },
): McpEndpoint {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const maxResultChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS
  const now = options.now ?? Date.now
  const sessions = new Map<string, Session>()

  /**
   * Closes every session idle past the timeout.
   *
   * Swept on each request rather than on a timer, so expiry needs no
   * background work and a test controls it entirely through the clock. A
   * session nobody touches again is collected by the next request anyone
   * makes; one that is touched again finds itself expired first.
   */
  async function sweep(): Promise<void> {
    const cutoff = now() - idleTimeoutMs
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        sessions.delete(id)
        await session.transport.close()
      }
    }
  }

  return {
    async handle(request, caller) {
      await sweep()

      // No server-initiated stream yet: nothing sends a notification until
      // tools exist that change. 405 is the specification's answer for a
      // server that offers none, and a client falls back to POST alone.
      if (request.method === 'GET') {
        return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } })
      }

      const sessionId = request.headers.get('mcp-session-id')

      if (sessionId) {
        const session = sessions.get(sessionId)
        if (
          !session ||
          session.caller.userId !== caller.userId ||
          session.caller.workspaceId !== caller.workspaceId
        ) {
          return sessionNotFound()
        }

        session.lastSeen = now()
        const response = await session.transport.handleRequest(request)
        if (request.method === 'DELETE') sessions.delete(sessionId)
        return response
      }

      // No session id: this must be an initialisation, and the transport
      // refuses anything else with the specification's own error. A transport
      // per session, because the SDK's transport *is* the session.
      const transport = new WebStandardStreamableHTTPServerTransport({
        // Unguessable, because the id travels in a header a proxy may log and
        // is the only thing tying a request to an existing session. Ownership
        // is still checked on every use; this makes guessing pointless as well.
        sessionIdGenerator: () => randomUUID(),
        // A reply per request rather than a stream: no call yet takes long
        // enough to need progress, and a held-open stream is a resource a
        // client can hold for as long as it likes.
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, caller, lastSeen: now() })
        },
      })
      await protocolServer({
        workspaceId: caller.workspaceId,
        origin: new URL(request.url).origin,
        dispatch,
        maxResultChars,
      }).connect(transport)

      const response = await transport.handleRequest(request)
      // Refused before a session existed, so nothing will ever use it again.
      if (!transport.sessionId) await transport.close()
      return response
    },
  }
}
