import { z } from 'zod'

/**
 * The MCP read tools' names, inputs and descriptions (MCP-2, architecture.md §14).
 *
 * The inputs are wire shapes, so they live here with every other one (CLAUDE.md
 * §10). The descriptions sit beside them because a description is part of a
 * tool's contract with the agent calling it: it decides whether the tool is
 * called at the right moment, constantly, or never (#86). Each is written as an
 * instruction to a colleague — what the tool is for, when to reach for it, and
 * what to do with the answer.
 */

export const MCP_PAGE_LIMIT = { default: 25, max: 100 } as const

const id = (what: string) => z.string().min(1).describe(what)

/** Every tool can be read on from where a cut result stopped (AC2). */
const continuation = {
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Only when a previous call was truncated: the offset its last line gave. Omit it otherwise.',
    ),
}

const paging = {
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe('The nextCursor from the previous page, exactly as given. Omit it for the first page.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MCP_PAGE_LIMIT.max)
    .optional()
    .describe(
      `How many items to return, at most ${MCP_PAGE_LIMIT.max}; ${MCP_PAGE_LIMIT.default} by default. A page may hold fewer when its items are large.`,
    ),
}

export const MCP_READ_TOOLS = {
  list_tasks: {
    title: 'List tasks',
    description:
      "Lists one team's tasks, in the team's board order, a page at a time. Use it to find a task " +
      'when you know roughly what it is about but not its id, or to see what else is in flight ' +
      'around the task you are working on. Filter by status, assignee or tag to keep pages short. ' +
      'Each item is a summary; call get_task with its id for acceptance criteria and linked ' +
      'documents. When the result has a nextCursor, pass it back to read the next page.',
    input: z
      .object({
        teamId: id('The team whose tasks to list. A task read with get_task carries its teamId.'),
        status: z.string().min(1).optional().describe('Only tasks in this status, e.g. "todo".'),
        assigneeId: id('Only tasks assigned to this user.').optional(),
        tag: z.string().min(1).optional().describe('Only tasks carrying this tag.'),
        ...paging,
        ...continuation,
      })
      .strict(),
  },
  get_task: {
    title: 'Read a task',
    description:
      'Reads one task in full: its title, description, acceptance criteria, status, assignee, ' +
      'parent, and the documents it was derived from. Call this before starting work on a task, ' +
      'and treat the acceptance criteria as the specification. When the task names a source ' +
      'document, read the relevant sections with get_document rather than guessing at the intent.',
    input: z
      .object({
        taskId: id('The task to read. Find one with list_tasks if you do not have its id.'),
        ...continuation,
      })
      .strict(),
  },
  list_documents: {
    title: 'List documents',
    description:
      "Lists one team's documents (PRDs, specs, decision records and the like), a page at a time, " +
      'with their type, title and status. Use it to find the document behind a piece of work, or ' +
      'to check whether something has already been written before proposing it. Call ' +
      'get_document with an id to read one. When the result has a nextCursor, pass it back to ' +
      'read the next page.',
    input: z
      .object({
        teamId: id('The team whose documents to list. A task read with get_task carries its teamId.'),
        ...paging,
        ...continuation,
      })
      .strict(),
  },
  get_document: {
    title: 'Read a document',
    description:
      'Reads one document: its title, type, status, and every section by key with its content. ' +
      'Use it for the reasoning behind a task: what problem is being solved, what is deliberately ' +
      'out of scope, and which decisions are already made. A long document arrives in parts; ' +
      'when a result ends with a truncation note, call again with the offset it gives.',
    input: z
      .object({
        documentId: id(
          'The document to read. get_task lists the documents a task came from; list_documents finds others.',
        ),
        ...continuation,
      })
      .strict(),
  },
} as const

export type McpReadToolName = keyof typeof MCP_READ_TOOLS

export function isMcpReadTool(name: string): name is McpReadToolName {
  return Object.hasOwn(MCP_READ_TOOLS, name)
}

/** A tool's input as JSON Schema, the form an MCP client is given. */
export function mcpToolInputSchema(name: McpReadToolName): {
  type: 'object'
  [key: string]: unknown
} {
  const schema = z.toJSONSchema(MCP_READ_TOOLS[name].input, { io: 'input' }) as Record<
    string,
    unknown
  >
  // The dialect marker means nothing to a client reading a tool list, and
  // some reject a schema that carries one.
  delete schema.$schema
  return { ...schema, type: 'object' }
}

/**
 * Parses a tool's arguments, or says exactly which argument is wrong and how.
 *
 * The message is written to be read by the agent that sent them, so it names
 * the argument and the expectation rather than dumping a schema error (AC5).
 */
export function parseMcpToolArguments<N extends McpReadToolName>(
  name: N,
  args: unknown,
): { ok: true; value: z.output<(typeof MCP_READ_TOOLS)[N]['input']> } | { ok: false; problem: string } {
  const parsed = MCP_READ_TOOLS[name].input.safeParse(args ?? {})
  if (parsed.success) {
    return { ok: true, value: parsed.data as z.output<(typeof MCP_READ_TOOLS)[N]['input']> }
  }
  const problem = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
    .join('; ')
  return { ok: false, problem }
}
