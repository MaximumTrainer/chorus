import { z } from 'zod'
import { DOCUMENT_TYPES } from './documents.js'
import { CreateTaskSchema, UpdateTaskSchema } from './tasks.js'

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
  get_session: {
    title: 'Read a session',
    description:
      'Reads one shaping session: how it started, its status, and the transcript of what people ' +
      'and the product agent said. Use it to recover the reasoning and the decisions behind a ' +
      'task or document that came out of a conversation, which the artefact itself may not ' +
      'record. A long transcript arrives in parts; when a result ends with a truncation note, ' +
      'call again with the offset it gives.',
    input: z
      .object({
        sessionId: id('The session to read. A task or document that came from one links to it.'),
        ...continuation,
      })
      .strict(),
  },
  get_coding_job: {
    title: 'Read a coding job',
    description:
      'Reads one coding job: whether it is queued, running, succeeded, failed or cancelled, its ' +
      'branch, its pull request once opened, its summary, and why it failed if it did. Use it to ' +
      'check on work handed to a sandboxed coding agent before starting the same task yourself, ' +
      'and read the failure before retrying, because it says what went wrong in plain words.',
    input: z
      .object({
        jobId: id('The coding job to read.'),
        ...continuation,
      })
      .strict(),
  },
} as const

export type McpReadToolName = keyof typeof MCP_READ_TOOLS

/**
 * A key the agent chooses for a create, so a retry after a lost reply returns
 * the original instead of making a second one (MCP-3 AC4). It travels to the
 * API as an `Idempotency-Key` header, so the guarantee is the API's.
 */
const idempotencyKey = {
  idempotencyKey: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe(
      'A key you choose, unique to this one create, such as your run id and a step number. ' +
        'If you are unsure whether a call went through, repeat it with the same key: you get ' +
        'the original back rather than a duplicate.',
    ),
}

/**
 * The MCP write tools for tasks and documents (MCP-3).
 *
 * Their fields are the API's own schemas, extended only with what addresses
 * the artefact, so a field the product accepts is a field an agent may send
 * and nothing else is. Strict, so a misspelt field is refused by name rather
 * than silently dropped (AC5).
 */
export const MCP_WRITE_TOOLS = {
  create_task: {
    title: 'Create a task',
    description:
      'Creates a task in a team, exactly as a person creating it in Chorus would: it is given ' +
      "the team's next key and is recorded in the audit log as done by the person you act for. " +
      'Write acceptance criteria as checkable statements, since they are what the work is ' +
      'reviewed against. Pass an idempotencyKey so a retry cannot create a duplicate. Returns ' +
      'the task, including its id and key.',
    input: CreateTaskSchema.extend({
      teamId: id('The team to create the task in. A task read with get_task carries its teamId.'),
      ...idempotencyKey,
    }).strict(),
  },
  update_task: {
    title: 'Update a task',
    description:
      "Changes a task's fields: title, description, acceptance criteria, tags, status, " +
      'priority, size, assignee or parent. Only the fields you send change. Use it to move a ' +
      'task through its statuses as you work, and to tick acceptance criteria you have met. ' +
      'Send null for size, assigneeId or parentId to clear them. Returns the updated task.',
    input: UpdateTaskSchema.extend({
      taskId: id('The task to change.'),
    }).strict(),
  },
  create_document: {
    title: 'Create a document',
    description:
      "Creates a document of a given type (prd, spec, strategy, freeform, gap_spec) from the team's " +
      'current template for that type, so it starts with the sections the team expects. Fill ' +
      'them with update_document using the section keys in the result. Pass an idempotencyKey ' +
      'so a retry cannot create a duplicate.',
    input: z
      .object({
        teamId: id('The team to create the document in.'),
        type: z.enum(DOCUMENT_TYPES).describe('The kind of document, which decides its template.'),
        title: z.string().trim().min(1).max(500).describe('The document title.'),
        ...idempotencyKey,
      })
      .strict(),
  },
  update_document: {
    title: 'Write document sections',
    description:
      "Writes content into a document's sections, addressed by their keys (read the document " +
      'with get_document to see them). Each section you send is replaced whole, and sections ' +
      'you do not send are left alone. Write Markdown. Returns the document as it now stands.',
    input: z
      .object({
        documentId: id('The document to write to.'),
        sections: z
          .array(
            z
              .object({
                key: z.string().min(1).describe('The section key, as get_document shows it.'),
                content: z.string().describe('The new content of that section, in Markdown.'),
              })
              .strict(),
          )
          .min(1)
          .describe('The sections to replace.'),
      })
      .strict(),
  },
} as const

export type McpWriteToolName = keyof typeof MCP_WRITE_TOOLS

/** Every tool the server offers, reads first. */
export const MCP_TOOLS = { ...MCP_READ_TOOLS, ...MCP_WRITE_TOOLS } as const
export type McpToolName = keyof typeof MCP_TOOLS

export function isMcpTool(name: string): name is McpToolName {
  return Object.hasOwn(MCP_TOOLS, name)
}

export function isMcpWriteTool(name: string): name is McpWriteToolName {
  return Object.hasOwn(MCP_WRITE_TOOLS, name)
}

export function isMcpReadTool(name: string): name is McpReadToolName {
  return Object.hasOwn(MCP_READ_TOOLS, name)
}

/** A tool's input as JSON Schema, the form an MCP client is given. */
export function mcpToolInputSchema(name: McpToolName): {
  type: 'object'
  [key: string]: unknown
} {
  const schema = z.toJSONSchema(MCP_TOOLS[name].input, { io: 'input' }) as Record<
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
export function parseMcpToolArguments<N extends McpToolName>(
  name: N,
  args: unknown,
): { ok: true; value: z.output<(typeof MCP_TOOLS)[N]['input']> } | { ok: false; problem: string } {
  const parsed = MCP_TOOLS[name].input.safeParse(args ?? {})
  if (parsed.success) {
    return { ok: true, value: parsed.data as z.output<(typeof MCP_TOOLS)[N]['input']> }
  }
  const problem = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
    .join('; ')
  return { ok: false, problem }
}
