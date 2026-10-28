import { createHash, randomUUID } from 'node:crypto'
import { takeToken, type BucketState, type RateLimit } from '@chorus/core'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { callTool, toolList } from './mcp-tools.js'
import type { McpCallLog, McpLoggedSession } from './mcp-call-log.js'
import {
  getPrompt,
  listResources,
  promptList,
  readResource,
  resourceTemplates,
  type ResourceContext,
} from './mcp-resources.js'

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
  /**
   * How many resources one `resources/list` page carries (MCP-4 AC5).
   *
   * A listing entry is a line, not a document, so a page can be long; it is
   * bounded so a workspace of thousands of artefacts is not one reply.
   */
  readonly resourcePageSize?: number
  /**
   * Where Chorus is reached from outside, for the canonical URL a resource's
   * front-matter carries (MCP-4 AC1). Not the request's own origin: a request
   * dispatched in-process, or one behind a proxy, arrives at an address no
   * reader could follow.
   */
  readonly baseUrl?: string
  /** Where each call is recorded (MCP-5 AC3). Absent, calls go unrecorded. */
  readonly callLog?: McpCallLog
  /**
   * How many tool calls one client may make (MCP-5 AC4).
   *
   * A burst of 60, then one a second sustained: an agent working a task makes
   * calls in clusters with pauses for editing and tests, and stays well inside
   * it, while one stuck in a loop is held to a pace that cannot flood the API.
   */
  readonly rateLimit?: RateLimit
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
const DEFAULT_RESOURCE_PAGE_SIZE = 100
const DEFAULT_RATE_LIMIT: RateLimit = { burst: 60, perMinute: 60 }

/**
 * Which client a request is from, for rate limiting.
 *
 * The credential, hashed: two of one person's agents hold two tokens, so one
 * running away does not throttle the other (AC4). The client's self-reported
 * name is not used, because it is the client's own claim.
 */
function clientKey(request: Request): string {
  const credential = request.headers.get('authorization') ?? request.headers.get('cookie') ?? ''
  return createHash('sha256').update(credential).digest('hex')
}

/** Whether a request carries a tool call, the only thing the limit counts. */
async function isToolCall(request: Request): Promise<boolean> {
  const body = (await request.clone().json().catch(() => undefined)) as unknown
  const messages = Array.isArray(body) ? body : [body]
  return messages.some(
    (message) =>
      typeof message === 'object' && message !== null && (message as { method?: unknown }).method === 'tools/call',
  )
}

/** The refusal a throttled client reads, in the transport's own error shape. */
function rateLimited(retryAfterMs: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: `Rate limit reached for this client: retry after ${seconds} second${seconds === 1 ? '' : 's'}.`,
      },
      id: null,
    }),
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(seconds) } },
  )
}

/** What a session's tools need to answer: whose workspace, and how to reach the API. */
interface ToolEnvironment {
  readonly workspaceId: string
  readonly origin: string
  readonly dispatch: (request: Request) => Promise<Response>
  readonly maxResultChars: number
  readonly resourcePageSize: number
  readonly baseUrl: string
  /** Records one call: who, through which client, which tool, how it went and how long it took. */
  readonly logCall: (call: { client: string; tool: string; outcome: 'ok' | 'error'; durationMs: number }) => Promise<void>
  readonly now: () => number
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
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
        prompts: { listChanged: false },
      },
    },
  )
  // Resources and prompts are read with the credential on the request that
  // asks, for the same reason as tool calls.
  const resourceContext = (headers: Headers): ResourceContext => ({
    workspaceId: environment.workspaceId,
    origin: environment.origin,
    dispatch: environment.dispatch,
    credentials: headers,
    pageSize: environment.resourcePageSize,
    baseUrl: environment.baseUrl,
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }))
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: resourceTemplates(),
  }))
  server.setRequestHandler(ListResourcesRequestSchema, async (request, extra) =>
    listResources(request.params?.cursor, resourceContext(headersOf(extra.requestInfo?.headers))),
  )
  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) =>
    readResource(request.params.uri, resourceContext(headersOf(extra.requestInfo?.headers))),
  )
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: promptList() }))
  server.setRequestHandler(GetPromptRequestSchema, async (request, extra) =>
    getPrompt(
      request.params.name,
      request.params.arguments,
      resourceContext(headersOf(extra.requestInfo?.headers)),
    ),
  )
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const started = environment.now()
    const tool = request.params.name
    // Logged whichever way it went, a call that threw included: the calls
    // worth reading afterwards are the ones that went wrong (MCP-5 AC3).
    const log = (outcome: 'ok' | 'error') =>
      environment.logCall({
        // The client's own claim about itself: recorded, never trusted.
        client: server.getClientVersion()?.name ?? 'unknown',
        tool,
        outcome,
        durationMs: environment.now() - started,
      })
    let result: Awaited<ReturnType<typeof callTool>>
    try {
      result = await callTool(tool, request.params.arguments, {
        ...environment,
        credentials: headersOf(extra.requestInfo?.headers),
      })
    } catch (error) {
      await log('error')
      throw error
    }
    const answer = result ?? {
      content: [
        {
          type: 'text' as const,
          text: `There is no tool called ${tool}. Call tools/list to see the tools this server offers.`,
        },
      ],
      isError: true,
    }
    await log(answer.isError ? 'error' : 'ok')
    return answer
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
  const resourcePageSize = options.resourcePageSize ?? DEFAULT_RESOURCE_PAGE_SIZE
  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT
  // Per process. With more than one API replica each enforces its own, so the
  // effective limit is the configured one times the replica count: a bound on
  // a runaway, not a quota (architecture.md §14).
  const buckets = new Map<string, BucketState>()
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
    // A bucket that has refilled is the same as no bucket, so it is forgotten
    // and the map holds only clients that called recently.
    const full = (rateLimit.burst / rateLimit.perMinute) * 60_000
    for (const [key, bucket] of buckets) {
      if (now() - bucket.at >= full) buckets.delete(key)
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

        if (request.method === 'POST' && (await isToolCall(request))) {
          const key = clientKey(request)
          const taken = takeToken(rateLimit, buckets.get(key), now())
          buckets.set(key, taken.state)
          if (!taken.allowed) return rateLimited(taken.retryAfterMs)
        }

        session.lastSeen = now()
        const response = await session.transport.handleRequest(request)
        if (request.method === 'DELETE') sessions.delete(sessionId)
        return response
      }

      // No session id: this must be an initialisation, and the transport
      // refuses anything else with the specification's own error. A transport
      // per session, because the SDK's transport *is* the session.
      const logged: McpLoggedSession = {
        workspaceId: caller.workspaceId,
        sessionId: '',
      }
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
          logged.sessionId = id
          sessions.set(id, { transport, caller, lastSeen: now() })
        },
      })
      await protocolServer({
        workspaceId: caller.workspaceId,
        origin: new URL(request.url).origin,
        dispatch,
        maxResultChars,
        resourcePageSize,
        baseUrl: options.baseUrl ?? new URL(request.url).origin,
        now,
        logCall: async (call) => {
          await options.callLog?.record(logged, { ...call, userId: caller.userId })
        },
      }).connect(transport)

      const response = await transport.handleRequest(request)
      // Refused before a session existed, so nothing will ever use it again.
      if (!transport.sessionId) await transport.close()
      return response
    },
  }
}
