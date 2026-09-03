import { ValidationError } from '@chorus/core'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'
import type { RepositoryService } from './repositories.js'

/**
 * Team repository routes (WS-3).
 *
 * Reading is a `member` action and linking an `admin` one, matching the role
 * model's split: a member works in the repositories a team has, an admin
 * decides which those are (architecture.md §20).
 */
export function repositoryRoutes(repositories: RepositoryService): RouteDefinition[] {
  return [
    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/teams/:teamId/repositories',
      summary: 'List the repositories linked to a team.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(
          await repositories.listForTeam(c.req.param('workspaceId'), c.req.param('teamId')),
        ),
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/teams/:teamId/repositories',
      summary: 'Link a repository to a team, through a workspace integration.',
      auth: { kind: 'workspace', role: 'admin', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
        const required = (field: string): string => {
          const value = body[field]
          if (typeof value !== 'string' || value.trim() === '') {
            throw new ValidationError(`${field} is required`, { field })
          }
          return value.trim()
        }

        return c.json(
          await repositories.link({
            workspaceId: c.req.param('workspaceId'),
            teamId: c.req.param('teamId'),
            actorId: caller(c).userId,
            integrationId: required('integrationId'),
            provider: required('provider'),
            fullName: required('fullName'),
            ...(typeof body.defaultBranch === 'string'
              ? { defaultBranch: body.defaultBranch }
              : {}),
            ...(typeof body.baseBranch === 'string' ? { baseBranch: body.baseBranch } : {}),
          }),
          201,
        )
      },
    }),

    route({
      method: 'DELETE',
      path: '/workspaces/:workspaceId/teams/:teamId/repositories/:repositoryId',
      summary: 'Unlink a repository from a team.',
      auth: { kind: 'workspace', role: 'admin', scopes: ['write:artefacts'] },
      handler: async (c) => {
        await repositories.unlink(
          c.req.param('workspaceId'),
          c.req.param('teamId'),
          caller(c).userId,
          c.req.param('repositoryId'),
        )
        return c.body(null, 204)
      },
    }),
  ]
}
