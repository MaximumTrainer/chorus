import { ValidationError } from '@chorus/core'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'
import type { TaskPushService } from './task-push.js'
import type { TaskSyncService } from './task-sync.js'

/**
 * Pushing a task to its tracker (TASK-4).
 *
 * `member` with `write:artefacts`: pushing is an everyday act of working a
 * task, and a push from the UI is the user's own explicit external action —
 * the `before_external_write` gate is for an *agent*-initiated push, which runs
 * through the connector sink tool, not through this route (AC6).
 *
 * Mounted unconditionally so the permission suite always covers it; when no
 * tracker push is wired, it refuses with a clear message rather than being
 * absent, the same shape the turn route uses.
 */
export function pushRoutes(push?: TaskPushService, sync?: TaskSyncService): RouteDefinition[] {
  return [
    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/tasks/:taskId/push',
      summary: 'Push a task to the team’s connected tracker, creating or updating its issue.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        if (!push) {
          throw new ValidationError('this deployment cannot push tasks to a tracker', {
            field: 'tracker',
          })
        }
        return c.json(
          await push.push({
            workspaceId: c.req.param('workspaceId'),
            taskId: c.req.param('taskId'),
            actorId: caller(c).userId,
          }),
        )
      },
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/tasks/:taskId/transition',
      summary: 'Push the task’s current status out to its tracker issue.',
      // The user's own explicit action, like a push; the agent path to the same
      // transition runs through the gated connector sink tool (TASK-4 AC6).
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        if (!sync) {
          throw new ValidationError('this deployment cannot push tasks to a tracker', {
            field: 'tracker',
          })
        }
        return c.json(
          await sync.transitionOut({
            workspaceId: c.req.param('workspaceId'),
            taskId: c.req.param('taskId'),
            actorId: caller(c).userId,
          }),
        )
      },
    }),
  ]
}
