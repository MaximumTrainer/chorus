import {
  MCP_PAGE_LIMIT,
  MCP_TOOLS,
  ValidationError,
  decodeCursor,
  isMcpTool,
  isMcpWriteTool,
  mcpToolInputSchema,
  pageOf,
  parseMcpToolArguments,
  truncated,
  type McpToolName,
} from '@chorus/core'

/**
 * The MCP tools, executed (MCP-2, MCP-3, ADR-0021).
 *
 * A tool call is answered by the API route that serves the same operation to
 * the web UI, dispatched in-process with the caller's own credential. So a
 * tool cannot return different data from its route (MCP-2 AC1), a write
 * cannot differ from the product's in defaults, key allocation or audit
 * (MCP-3 AC1), and nothing is permitted where the route is refused: the
 * route's declared role and scope, the team override and the audited refusal
 * all apply unchanged (MCP-5 AC1). What is added here is only what an agent
 * needs and a browser does not: bounded results, retry-safe creates, and
 * errors that say what to do next.
 */

export interface ToolCallContext {
  readonly workspaceId: string
  /** The origin the MCP request arrived at, so a dispatched read resolves the same way. */
  readonly origin: string
  /** The caller's credential, forwarded exactly as presented. */
  readonly credentials: Headers
  readonly dispatch: (request: Request) => Promise<Response>
  readonly maxResultChars: number
}

export interface ToolResult {
  [key: string]: unknown
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

interface ToolRoute {
  /** GET unless said otherwise. */
  readonly method?: 'POST' | 'PATCH'
  readonly path: (workspaceId: string, args: Record<string, unknown>) => string
  /** The request body: the arguments, less those that address the artefact. */
  readonly body?: (args: Record<string, unknown>) => unknown
  /** Served a page at a time: the route returns an array. */
  readonly list: boolean
  /**
   * The not-found answer, fixed per tool rather than taken from the route.
   *
   * An id from another workspace and an id that never existed must read
   * identically (AC6). Composing the message here, from nothing but what the
   * agent itself sent, makes that true by construction rather than by the
   * route happening to phrase both the same way.
   */
  readonly notFound: (args: Record<string, unknown>) => string
}

const segment = (value: unknown) => encodeURIComponent(String(value))

/** Arguments that address an artefact or steer the call, never sent as fields. */
const without =
  (...fields: string[]) =>
  (args: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(args).filter(([field]) => !fields.includes(field) && field !== 'idempotencyKey'),
    )

const ROUTES: Readonly<Record<McpToolName, ToolRoute>> = {
  list_tasks: {
    list: true,
    path: (workspaceId, args) => {
      const query = new URLSearchParams()
      for (const key of ['status', 'assigneeId', 'tag'] as const) {
        if (typeof args[key] === 'string') query.set(key, args[key])
      }
      const search = query.size > 0 ? `?${query.toString()}` : ''
      return `/workspaces/${segment(workspaceId)}/teams/${segment(args.teamId)}/tasks${search}`
    },
    notFound: (args) =>
      `Not found: there is no team with id ${String(args.teamId)} in this workspace that you can see. ` +
      'Read a task with get_task to find the teamId it belongs to.',
  },
  get_task: {
    list: false,
    path: (workspaceId, args) => `/workspaces/${segment(workspaceId)}/tasks/${segment(args.taskId)}`,
    notFound: (args) =>
      `Not found: there is no task with id ${String(args.taskId)} in this workspace that you can see. ` +
      'Check the id, or use list_tasks to find the task.',
  },
  list_documents: {
    list: true,
    path: (workspaceId, args) =>
      `/workspaces/${segment(workspaceId)}/teams/${segment(args.teamId)}/documents`,
    notFound: (args) =>
      `Not found: there is no team with id ${String(args.teamId)} in this workspace that you can see. ` +
      'Read a task with get_task to find the teamId it belongs to.',
  },
  get_document: {
    list: false,
    path: (workspaceId, args) =>
      `/workspaces/${segment(workspaceId)}/documents/${segment(args.documentId)}`,
    notFound: (args) =>
      `Not found: there is no document with id ${String(args.documentId)} in this workspace that you can see. ` +
      'Check the id, or use list_documents to find the document.',
  },
  get_session: {
    list: false,
    path: (workspaceId, args) =>
      `/workspaces/${segment(workspaceId)}/sessions/${segment(args.sessionId)}`,
    notFound: (args) =>
      `Not found: there is no session with id ${String(args.sessionId)} in this workspace that you can see. ` +
      'Check the id; a task or document that came from a session links to it.',
  },
  get_coding_job: {
    list: false,
    path: (workspaceId, args) =>
      `/workspaces/${segment(workspaceId)}/coding-jobs/${segment(args.jobId)}`,
    notFound: (args) =>
      `Not found: there is no coding job with id ${String(args.jobId)} in this workspace that you can see. ` +
      'Check the id; it is the one returned when the job was launched.',
  },
  create_task: {
    list: false,
    method: 'POST',
    path: (workspaceId, args) =>
      `/workspaces/${segment(workspaceId)}/teams/${segment(args.teamId)}/tasks`,
    body: without('teamId'),
    notFound: (args) =>
      `Not found: there is no team with id ${String(args.teamId)} in this workspace that you can see. ` +
      'Read a task with get_task to find the teamId it belongs to.',
  },
  update_task: {
    list: false,
    method: 'PATCH',
    path: (workspaceId, args) => `/workspaces/${segment(workspaceId)}/tasks/${segment(args.taskId)}`,
    body: without('taskId'),
    notFound: (args) =>
      `Not found: there is no task with id ${String(args.taskId)} in this workspace that you can see. ` +
      'Check the id, or use list_tasks to find the task.',
  },
  create_document: {
    list: false,
    method: 'POST',
    path: (workspaceId, args) =>
      `/workspaces/${segment(workspaceId)}/teams/${segment(args.teamId)}/documents`,
    body: without('teamId'),
    notFound: (args) =>
      `Not found: there is no team with id ${String(args.teamId)} in this workspace that you can see. ` +
      'Read a task with get_task to find the teamId it belongs to.',
  },
  update_document: {
    list: false,
    method: 'PATCH',
    path: (workspaceId, args) =>
      `/workspaces/${segment(workspaceId)}/documents/${segment(args.documentId)}`,
    body: without('documentId'),
    notFound: (args) =>
      `Not found: there is no document with id ${String(args.documentId)} in this workspace that you can see. ` +
      'Check the id, or use list_documents to find the document.',
  },
}

/** The tools as `tools/list` presents them. */
export function toolList() {
  return (Object.keys(MCP_TOOLS) as McpToolName[]).map((name) => ({
    name,
    title: MCP_TOOLS[name].title,
    description: MCP_TOOLS[name].description,
    inputSchema: mcpToolInputSchema(name),
    // Hints for a client deciding whether to ask the person first. Every tool
    // acts only in this workspace, and none deletes anything. Updates are
    // idempotent by nature; creates are made so by their key.
    annotations: isMcpWriteTool(name)
      ? {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: ROUTES[name].method === 'PATCH',
          openWorldHint: false,
        }
      : { readOnlyHint: true, openWorldHint: false },
  }))
}

function failure(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** The detail an RFC 9457 problem carries, or the status if the body is not one. */
async function problemDetail(response: Response): Promise<{ detail: string; reason?: unknown }> {
  const body = (await response.json().catch(() => undefined)) as
    | { detail?: unknown; reason?: unknown }
    | undefined
  return {
    detail: typeof body?.detail === 'string' ? body.detail : `HTTP ${response.status}`,
    reason: body?.reason,
  }
}

/** A refused call, turned into an answer an agent can act on (MCP-2 AC5, MCP-3 AC5). */
async function refusal(
  tool: McpToolName,
  response: Response,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (response.status === 404) return failure(ROUTES[tool].notFound(args))

  const { detail, reason } = await problemDetail(response)
  switch (response.status) {
    case 400:
      return failure(`Invalid arguments for ${tool}: ${detail}. Correct them and call again.`)
    case 409:
      return failure(
        `Conflict: ${detail}. Read the artefact again for its current state before retrying.`,
      )
    case 422:
      return failure(`Refused: ${detail}.`)
    case 401:
      return failure(
        `Not authenticated: ${detail}. The credential this connection uses has expired or been ` +
          'revoked; the person running you needs to reconnect.',
      )
    case 403:
      return failure(
        reason === 'scope'
          ? `Not permitted: ${detail}. This connection was granted without it; the person running ` +
              'you can reconnect granting that scope. Retrying will not help.'
          : `Not permitted: ${detail}. Your role in this workspace does not allow ${tool}; ` +
              'retrying will not help.',
      )
    default:
      return failure(
        `${tool} failed: ${detail}. This is not something different arguments would fix; ` +
          'try again later, and tell the person running you if it persists.',
      )
  }
}

/** Answers a `tools/call`, or returns undefined for a tool this module does not serve. */
export async function callTool(
  name: string,
  rawArgs: unknown,
  context: ToolCallContext,
): Promise<ToolResult | undefined> {
  if (!isMcpTool(name)) return undefined

  const parsed = parseMcpToolArguments(name, rawArgs)
  if (!parsed.ok) {
    return failure(
      `Invalid arguments for ${name}: ${parsed.problem}. Check the tool's input schema and call again.`,
    )
  }
  const args = parsed.value as Record<string, unknown>

  try {
    const route = ROUTES[name]
    const headers = new Headers()
    for (const header of ['authorization', 'cookie']) {
      const value = context.credentials.get(header)
      if (value) headers.set(header, value)
    }
    if (route.body) headers.set('content-type', 'application/json')
    // The key is the API's to honour (architecture.md §19), so a script and
    // an agent retrying the same create get the same protection.
    if (typeof args.idempotencyKey === 'string') headers.set('idempotency-key', args.idempotencyKey)
    const response = await context.dispatch(
      new Request(`${context.origin}${route.path(context.workspaceId, args)}`, {
        method: route.method ?? 'GET',
        headers,
        ...(route.body ? { body: JSON.stringify(route.body(args)) } : {}),
      }),
    )
    if (!response.ok) return await refusal(name, response, args)

    const data: unknown = await response.json()
    const shaped = route.list
      ? pageOf(data as unknown[], {
          offset: typeof args.cursor === 'string' ? decodeCursor(args.cursor) : 0,
          limit: typeof args.limit === 'number' ? args.limit : MCP_PAGE_LIMIT.default,
          maxChars: context.maxResultChars,
        })
      : data

    const cut = truncated(JSON.stringify(shaped), {
      offset: typeof args.offset === 'number' ? args.offset : 0,
      maxChars: context.maxResultChars,
      tool: name,
    })
    return {
      content: [
        { type: 'text', text: cut.body },
        ...(cut.continuation ? [{ type: 'text' as const, text: cut.continuation }] : []),
      ],
    }
  } catch (error) {
    // Only an argument the agent can correct becomes a tool result; anything
    // else is the server's fault and propagates as one.
    if (error instanceof ValidationError) {
      return failure(`Invalid arguments for ${name}: ${error.message}.`)
    }
    throw error
  }
}
