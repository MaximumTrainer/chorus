import { createHash } from 'node:crypto'
import {
  ConflictError,
  CreateTaskSchema,
  UpdateTaskSchema,
  ValidationError,
  type ChildDisposition,
  type TaskRecord,
} from '@chorus/core'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'
import { requireChildDisposition, type TaskService } from './tasks.js'

/**
 * Task routes (TASK-1).
 *
 * Reading and writing are both `member` actions: a task is the unit of work a
 * team member does, and requiring a senior role to create one would make the
 * tool harder to use than the notebook it replaces.
 *
 * Bodies are parsed by the Zod schemas in `core` rather than checked here, so
 * the API and the MCP tools that arrive with WP-1.11 validate against one
 * definition — two would drift, and the MCP side is where nobody would notice.
 */
/**
 * A task's version, for optimistic concurrency (AC4).
 *
 * Derived from `updatedAt` rather than a stored counter: the timestamp already
 * changes on every write, and a second source of truth for "has this changed"
 * is one that can disagree with the first.
 */
function etagFor(task: TaskRecord): string {
  const digest = createHash('sha256')
    .update(`${task.id}:${task.updatedAt}`)
    .digest('hex')
    .slice(0, 32)
  return `"${digest}"`
}

export function taskRoutes(tasks: TaskService): RouteDefinition[] {
  return [
    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/teams/:teamId/tasks',
      summary: 'Create a task in a team, assigning its human key.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = await c.req.json().catch(() => ({}))
        const parsed = CreateTaskSchema.safeParse(body)
        if (!parsed.success) {
          throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid task', {
            field: parsed.error.issues[0]?.path.join('.') ?? 'body',
          })
        }

        return c.json(
          await tasks.create({
            workspaceId: c.req.param('workspaceId'),
            teamId: c.req.param('teamId'),
            actorId: caller(c).userId,
            task: parsed.data,
          }),
          201,
        )
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/teams/:teamId/tasks',
      summary: 'List a team’s tasks, optionally scoped and filtered.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) => {
        const scopeType = c.req.query('scopeType')
        const scopeId = c.req.query('scopeId')

        return c.json(
          await tasks.listForTeam(c.req.param('workspaceId'), c.req.param('teamId'), {
            // Scope is a *link*, not a column, so a task can belong to a
            // session and a document at once without the schema growing a
            // field per kind of scope.
            ...(scopeType && scopeId ? { scope: { type: scopeType, id: scopeId } } : {}),
            ...(c.req.query('status') ? { status: c.req.query('status') } : {}),
            ...(c.req.query('assigneeId') ? { assigneeId: c.req.query('assigneeId') } : {}),
            ...(c.req.query('tag') ? { tag: c.req.query('tag') } : {}),
          }),
        )
      },
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/tasks/bulk',
      summary: 'Apply one change to many tasks, reporting each outcome.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as {
          taskIds?: unknown
          changes?: unknown
        }
        if (!Array.isArray(body.taskIds) || body.taskIds.length === 0) {
          throw new ValidationError('taskIds must be a non-empty array', { field: 'taskIds' })
        }
        const parsed = UpdateTaskSchema.safeParse(body.changes ?? {})
        if (!parsed.success) {
          throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid change', {
            field: 'changes',
          })
        }

        const results = await tasks.bulkUpdate({
          workspaceId: c.req.param('workspaceId'),
          taskIds: body.taskIds.map(String),
          actorId: caller(c).userId,
          changes: parsed.data,
        })

        // 207, because the batch genuinely had mixed outcomes and a single
        // status code would have to lie about one of them.
        return c.json({ results }, 207)
      },
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/tasks/:taskId/move',
      summary: 'Place a task between two siblings, optionally under a new parent.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as {
          before?: string | null
          after?: string | null
          parentId?: string | null
        }

        return c.json(
          await tasks.move({
            workspaceId: c.req.param('workspaceId'),
            taskId: c.req.param('taskId'),
            actorId: caller(c).userId,
            ...('before' in body ? { before: body.before } : {}),
            ...('after' in body ? { after: body.after } : {}),
            ...('parentId' in body ? { parentId: body.parentId } : {}),
          }),
        )
      },
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/tasks/:taskId/links',
      summary: 'Link a task to another artefact.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as {
          toType?: unknown
          toId?: unknown
          relation?: unknown
        }
        if (typeof body.toType !== 'string' || typeof body.toId !== 'string') {
          throw new ValidationError('toType and toId are required', { field: 'toType' })
        }

        await tasks.link({
          workspaceId: c.req.param('workspaceId'),
          taskId: c.req.param('taskId'),
          actorId: caller(c).userId,
          toType: body.toType,
          toId: body.toId,
          ...(typeof body.relation === 'string' ? { relation: body.relation } : {}),
        })
        return c.json({ ok: true }, 201)
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/tasks/:taskId',
      summary: 'Read one task.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) => {
        const task = await tasks.get(c.req.param('workspaceId'), c.req.param('taskId'))
        // The version a client sends back as `If-Match`. Without it there is
        // no way to write optimistically and still detect a lost update.
        c.header('ETag', etagFor(task))
        return c.json(task)
      },
    }),

    route({
      method: 'PATCH',
      path: '/workspaces/:workspaceId/tasks/:taskId',
      summary: 'Update a task, including its acceptance criteria and its parent.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = await c.req.json().catch(() => ({}))
        const parsed = UpdateTaskSchema.safeParse(body)
        if (!parsed.success) {
          throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid update', {
            field: parsed.error.issues[0]?.path.join('.') ?? 'body',
          })
        }

        const workspaceId = c.req.param('workspaceId')
        const taskId = c.req.param('taskId')

        // Optimistic concurrency, and only when asked for: a client that sends
        // no `If-Match` has not claimed to know the current state, and
        // demanding one would break every simple caller.
        const expected = c.req.header('if-match')
        if (expected) {
          const current = await tasks.get(workspaceId, taskId)
          if (etagFor(current) !== expected) {
            // The current state travels with the refusal, so a client can
            // reconcile in one round trip and explain *what* changed rather
            // than only that something did.
            throw new ConflictError('This task changed since you read it', { current })
          }
        }

        const updated = await tasks.update({
          workspaceId,
          taskId,
          actorId: caller(c).userId,
          changes: parsed.data,
        })
        c.header('ETag', etagFor(updated))
        return c.json(updated)
      },
    }),

    route({
      method: 'DELETE',
      path: '/workspaces/:workspaceId/tasks/:taskId',
      summary: 'Delete a task, cascading to or re-parenting its children.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        const taskId = c.req.param('taskId')

        // The choice is only demanded when there is something to lose. A leaf
        // has no children, so insisting on a disposition there would be
        // ceremony rather than a safeguard.
        const children = await tasks.childCount(workspaceId, taskId)
        const disposition: ChildDisposition =
          children === 0 ? 'cascade' : requireChildDisposition(c.req.query('children'))

        await tasks.remove({
          workspaceId,
          taskId,
          actorId: caller(c).userId,
          children: disposition,
        })
        return c.body(null, 204)
      },
    }),
  ]
}
