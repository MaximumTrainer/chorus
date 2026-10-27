import { join } from 'node:path'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { WORKFLOW_ROOT } from '@chorus/agent'
import {
  MCP_PROMPTS,
  MCP_RESOURCE_TEMPLATES,
  decodeCursor,
  encodeCursor,
  missingPromptArguments,
  parseResourceUri,
  resourceUri,
  taskToMarkdown,
  withFrontMatter,
  type McpResourceKind,
  type TaskRecord,
} from '@chorus/core'
import { loadPromptDirectory, renderPrompt } from '@chorus/llm'

/**
 * The MCP resources and prompts, served (MCP-4, ADR-0021).
 *
 * Like the tools, each is answered by the API route that serves the same
 * thing to the product, dispatched with the caller's own credential. So a
 * resource is refused wherever its route is, an id from another workspace
 * reads exactly like one that never existed, and `implement-task` is the
 * sandbox's brief because it is fetched from the one route that builds it.
 */

export interface ResourceContext {
  readonly workspaceId: string
  readonly origin: string
  readonly credentials: Headers
  readonly dispatch: (request: Request) => Promise<Response>
  /** How many resources one `resources/list` page carries (AC5). */
  readonly pageSize: number
  /** Where Chorus is reached from outside, for canonical URLs. */
  readonly baseUrl: string
}

/** The specification's code for a resource that does not exist. */
const RESOURCE_NOT_FOUND = -32002

const prompts = loadPromptDirectory(join(WORKFLOW_ROOT, '..', 'prompts'))

async function get(context: ResourceContext, path: string): Promise<Response> {
  const headers = new Headers()
  for (const header of ['authorization', 'cookie']) {
    const value = context.credentials.get(header)
    if (value) headers.set(header, value)
  }
  return context.dispatch(new Request(`${context.origin}${path}`, { headers }))
}

/**
 * A refused read, as the protocol error a client shows.
 *
 * Not-found is composed from the URI alone, so another workspace's artefact and
 * one that never existed produce the same words (AC1).
 */
async function refused(response: Response, what: string): Promise<McpError> {
  if (response.status === 404) {
    return new McpError(
      RESOURCE_NOT_FOUND,
      `Not found: there is no ${what} in this workspace that you can see. Check the id.`,
    )
  }
  const body = (await response.json().catch(() => undefined)) as { detail?: unknown } | undefined
  const detail = typeof body?.detail === 'string' ? body.detail : `HTTP ${response.status}`
  if (response.status === 401 || response.status === 403) {
    return new McpError(ErrorCode.InvalidRequest, `Not permitted: ${detail}.`)
  }
  return new McpError(ErrorCode.InternalError, `Reading ${what} failed: ${detail}. Try again later.`)
}

async function json<T>(context: ResourceContext, path: string, what: string): Promise<T> {
  const response = await get(context, path)
  if (!response.ok) throw await refused(response, what)
  return (await response.json()) as T
}

async function text(context: ResourceContext, path: string, what: string): Promise<string> {
  const response = await get(context, path)
  if (!response.ok) throw await refused(response, what)
  return response.text()
}

const workspacePath = (context: ResourceContext) =>
  `/workspaces/${encodeURIComponent(context.workspaceId)}`

interface DocumentView {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly status: string
  readonly updatedAt: string
}

/** One artefact as a resource: Markdown under front-matter that is enough to cite it. */
async function render(
  context: ResourceContext,
  kind: McpResourceKind,
  id: string,
): Promise<string> {
  const base = workspacePath(context)
  const segment = encodeURIComponent(id)
  if (kind === 'task') {
    const task = await json<TaskRecord>(context, `${base}/tasks/${segment}`, `task with id ${id}`)
    return withFrontMatter(
      [
        ['id', task.id, 'plain'],
        ['kind', 'task', 'plain'],
        ['key', task.key, 'plain'],
        ['title', task.title, 'text'],
        ['status', task.status, 'plain'],
        ['url', `${context.baseUrl}${base}/tasks/${segment}`, 'plain'],
        ['updatedAt', task.updatedAt, 'plain'],
      ],
      taskToMarkdown(task),
    )
  }
  const what = `document with id ${id}`
  const document = await json<DocumentView>(context, `${base}/documents/${segment}`, what)
  // The export's own Markdown, through the shared serialiser (DOC-7, AC4).
  const body = await text(context, `${base}/documents/${segment}/export?format=markdown`, what)
  return withFrontMatter(
    [
      ['id', document.id, 'plain'],
      ['kind', 'document', 'plain'],
      ['type', document.type, 'plain'],
      ['title', document.title, 'text'],
      ['status', document.status, 'plain'],
      ['url', `${context.baseUrl}${base}/documents/${segment}`, 'plain'],
      ['updatedAt', document.updatedAt, 'plain'],
    ],
    body,
  )
}

export function resourceTemplates() {
  return MCP_RESOURCE_TEMPLATES.map((template) => ({ ...template }))
}

export async function readResource(uri: string, context: ResourceContext) {
  const parsed = parseResourceUri(uri)
  if (!parsed) {
    throw new McpError(
      RESOURCE_NOT_FOUND,
      `Not found: ${uri} is not a resource this server offers. It serves chorus://task/{id} and chorus://doc/{id}.`,
    )
  }
  return {
    contents: [{ uri, mimeType: 'text/markdown', text: await render(context, parsed.kind, parsed.id) }],
  }
}

/**
 * Every task and document the caller can see, a page at a time (AC5).
 *
 * Gathered through the list routes, so the listing is filtered exactly as the
 * product filters it, team by team in the order the product shows them.
 */
export async function listResources(cursor: string | undefined, context: ResourceContext) {
  const base = workspacePath(context)
  const teams = await json<Array<{ id: string }>>(context, `${base}/teams`, 'team list')
  const all: Array<{ uri: string; name: string; title: string; mimeType: string }> = []
  for (const team of teams) {
    const teamPath = `${base}/teams/${encodeURIComponent(team.id)}`
    const tasks = await json<TaskRecord[]>(context, `${teamPath}/tasks`, 'task list')
    for (const task of tasks) {
      all.push({
        uri: resourceUri('task', task.id),
        name: task.key,
        title: `${task.key} — ${task.title}`,
        mimeType: 'text/markdown',
      })
    }
    const documents = await json<DocumentView[]>(context, `${teamPath}/documents`, 'document list')
    for (const document of documents) {
      all.push({
        uri: resourceUri('doc', document.id),
        name: document.title,
        title: document.title,
        mimeType: 'text/markdown',
      })
    }
  }

  let offset = 0
  if (cursor !== undefined) {
    try {
      offset = decodeCursor(cursor)
    } catch (error) {
      throw new McpError(ErrorCode.InvalidParams, (error as Error).message)
    }
  }
  const end = offset + context.pageSize
  return {
    resources: all.slice(offset, end),
    ...(end < all.length ? { nextCursor: encodeCursor(end) } : {}),
  }
}

export function promptList() {
  return MCP_PROMPTS.map((prompt) => ({
    name: prompt.name,
    title: prompt.title,
    description: prompt.description,
    arguments: prompt.arguments.map((argument) => ({ ...argument })),
  }))
}

export async function getPrompt(
  name: string,
  args: Record<string, string> | undefined,
  context: ResourceContext,
) {
  const prompt = MCP_PROMPTS.find((each) => each.name === name)
  if (!prompt) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `There is no prompt called ${name}. Call prompts/list to see the prompts this server offers.`,
    )
  }
  const missing = missingPromptArguments(prompt, args)
  if (missing.length > 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${name} needs ${missing.join(' and ')}: ${missing
        .map((field) => prompt.arguments.find((argument) => argument.name === field)!.description)
        .join(' ')}`,
    )
  }

  const base = workspacePath(context)
  const message = (body: string) => ({
    description: prompt.description,
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: body } }],
  })

  switch (prompt.name) {
    case 'implement-task': {
      // The brief route, so this is the sandbox's brief byte for byte (AC2).
      const taskId = encodeURIComponent(args!.taskId!)
      return message(await text(context, `${base}/tasks/${taskId}/brief`, `task with id ${args!.taskId}`))
    }
    case 'review-spec':
      return message(
        renderPrompt(prompts.get('mcp/review-spec'), {
          document: await render(context, 'doc', args!.documentId!),
        }),
      )
    default: {
      const task = await json<TaskRecord>(
        context,
        `${base}/tasks/${encodeURIComponent(args!.taskId!)}`,
        `task with id ${args!.taskId}`,
      )
      return message(
        renderPrompt(prompts.get('mcp/write-tests-for-task'), {
          task: await render(context, 'task', task.id),
          taskKey: task.key,
        }),
      )
    }
  }
}
