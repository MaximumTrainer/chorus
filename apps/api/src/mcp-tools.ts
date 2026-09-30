import {
  MCP_PAGE_LIMIT,
  MCP_READ_TOOLS,
  ValidationError,
  decodeCursor,
  isMcpReadTool,
  mcpToolInputSchema,
  pageOf,
  parseMcpToolArguments,
  truncated,
  type McpReadToolName,
} from '@chorus/core'

/**
 * The MCP read tools, executed (MCP-2, ADR-0021).
 *
 * A tool call is answered by the API route that serves the same read to the
 * web UI, dispatched in-process with the caller's own credential. So a tool
 * cannot return different data from its route (AC1), and it cannot be
 * permitted where the route is refused: the route's declared role and scope,
 * the team override and the audited refusal all apply unchanged (MCP-5 AC1).
 * What is added here is only what an agent needs and a browser does not:
 * bounded results (AC2) and errors that say what to do next (AC5).
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

interface ReadRoute {
  readonly path: (workspaceId: string, args: Record<string, unknown>) => string
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

const ROUTES: Readonly<Record<McpReadToolName, ReadRoute>> = {
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
}

/** The tools as `tools/list` presents them. */
export function readToolList() {
  return (Object.keys(MCP_READ_TOOLS) as McpReadToolName[]).map((name) => ({
    name,
    title: MCP_READ_TOOLS[name].title,
    description: MCP_READ_TOOLS[name].description,
    inputSchema: mcpToolInputSchema(name),
    // Hints for a client deciding whether to ask the person first. Every one
    // of these only reads, and reads only this workspace.
    annotations: { readOnlyHint: true, openWorldHint: false },
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

/** A refused read, turned into an answer an agent can act on (AC5). */
async function refusal(
  tool: McpReadToolName,
  response: Response,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (response.status === 404) return failure(ROUTES[tool].notFound(args))

  const { detail, reason } = await problemDetail(response)
  switch (response.status) {
    case 400:
      return failure(`Invalid arguments for ${tool}: ${detail}. Correct them and call again.`)
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
export async function callReadTool(
  name: string,
  rawArgs: unknown,
  context: ToolCallContext,
): Promise<ToolResult | undefined> {
  if (!isMcpReadTool(name)) return undefined

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
    const response = await context.dispatch(
      new Request(`${context.origin}${route.path(context.workspaceId, args)}`, { headers }),
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
