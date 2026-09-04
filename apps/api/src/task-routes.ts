import {
  CreateTaskSchema,
  UpdateTaskSchema,
  ValidationError,
  type ChildDisposition,
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
      summary: 'List a team’s tasks.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(
          await tasks.listForTeam(c.req.param('workspaceId'), c.req.param('teamId')),
        ),
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/tasks/:taskId',
      summary: 'Read one task.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(await tasks.get(c.req.param('workspaceId'), c.req.param('taskId'))),
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

        return c.json(
          await tasks.update({
            workspaceId: c.req.param('workspaceId'),
            taskId: c.req.param('taskId'),
            actorId: caller(c).userId,
            changes: parsed.data,
          }),
        )
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
