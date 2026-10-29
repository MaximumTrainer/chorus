import { atLeast } from '@chorus/core'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'
import type { HomeService } from './home.js'

/**
 * The team home route (NAV-2).
 *
 * A read, so `member` with `read:artefacts` — everyone on the team can see
 * what is happening. Whether the queue offers its launch actions is a separate
 * question of role: launching a coding job is `senior_member` (CODE-1), so the
 * home tells the surface whether to offer the action rather than letting it
 * guess (AC5). The queue itself is visible regardless.
 */
export function homeRoutes(home: HomeService): RouteDefinition[] {
  return [
    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/teams/:teamId/home',
      summary: 'The team home: recent sessions, proposals, the coding queue and the checkpoint inbox.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(
          await home.read({
            workspaceId: c.req.param('workspaceId'),
            teamId: c.req.param('teamId'),
            // The same bar launching a job clears, so the action is offered
            // exactly to those who could complete it.
            canLaunch: atLeast(caller(c).role, 'senior_member'),
          }),
        ),
    }),
  ]
}
