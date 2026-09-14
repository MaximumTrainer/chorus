import { ValidationError } from '@chorus/core'
import type { CodingJobService } from '@chorus/coding'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'

/**
 * Launching, cancelling and reading coding jobs (CODE-1).
 *
 * The role is declared here and enforced by the authorisation middleware, so
 * the declaration *is* the enforcement — a route can be wrong, which is
 * testable, but it can no longer disagree with itself.
 *
 * The eligibility decision itself lives in `packages/coding` rather than in
 * these handlers, because the MCP `start_coding_job` tool has to reach the same
 * verdict. Two handlers agreeing today is not one decision, and the MCP path is
 * both the one where a divergence would go unnoticed longest and the one an
 * agent uses with nobody watching.
 */
export function codingJobRoutes(jobs: CodingJobService): RouteDefinition[] {
  return [
    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/teams/:teamId/tasks/:taskId/coding-jobs',
      summary: 'Launch a coding job for a task.',
      // CODE-1 AC1 / WS-4 AC1: senior_member or above. A coding job spends
      // money and writes to a repository, which is why this is not `member`.
      //
      // The scope is `run:coding` rather than `write:artefacts` (#149). Role
      // and scope answer different questions — who the caller is, and what
      // they lent this credential to do — and architecture.md §17 names
      // `run:coding` for exactly this. Declaring the general write scope meant
      // a token handed to a script for editing documents could also spend
      // money and push a branch.
      auth: { kind: 'workspace', role: 'senior_member', scopes: ['run:coding'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { adapter?: unknown }
        if (body.adapter !== undefined && typeof body.adapter !== 'string') {
          throw new ValidationError('adapter must be a string when given', { field: 'adapter' })
        }

        const who = caller(c)
        const outcome = await jobs.launch({
          workspaceId: c.req.param('workspaceId'),
          teamId: c.req.param('teamId'),
          taskId: c.req.param('taskId'),
          actorId: who.userId,
          role: who.role,
          ...(typeof body.adapter === 'string' ? { adapter: body.adapter } : {}),
        })

        // 200 rather than 201 when the job already existed: nothing was
        // created, and a caller that retried a request it was unsure about
        // should be able to tell.
        return c.json(outcome.job, outcome.existing ? 200 : 201)
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/tasks/:taskId/coding-jobs',
      summary: "List a task's coding jobs, most recent first.",
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(
          await jobs.listForTask(c.req.param('workspaceId'), c.req.param('taskId')),
        ),
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/coding-jobs/:jobId/cancel',
      summary: 'Cancel a queued or running coding job.',
      auth: { kind: 'workspace', role: 'senior_member', scopes: ['run:coding'] },
      handler: async (c) =>
        c.json(
          await jobs.cancel(
            c.req.param('workspaceId'),
            c.req.param('jobId'),
            caller(c).userId,
          ),
        ),
    }),
  ]
}
