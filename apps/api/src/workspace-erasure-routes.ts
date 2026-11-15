import { ValidationError } from '@chorus/core'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'
import type { WorkspaceService } from './workspaces.js'
import type { WorkspaceErasure } from './workspace-erasure.js'

/**
 * Erasing a workspace (NFR-4 AC5, AC6).
 *
 * The one action in the product that cannot be undone, so it is gated three
 * ways: `owner` only — not admin, because it destroys what every member has
 * made; `sessionOnly`, so a token lent to software can never do it; and the
 * caller must type the workspace's slug back, so it is this workspace they
 * meant and not the one they happened to have open. The erasure records itself
 * outside the workspace, since the workspace's own audit trail goes with it.
 */
export function workspaceErasureRoutes(erasure: WorkspaceErasure, workspaces: WorkspaceService): RouteDefinition[] {
  return [
    route({
      method: 'DELETE',
      path: '/workspaces/:workspaceId',
      summary: 'Erase this workspace and everything it owns, permanently. Requires typing its slug back.',
      auth: { kind: 'workspace', role: 'owner', scopes: ['write:artefacts'], sessionOnly: true },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        const { userId } = caller(c)
        const body = (await c.req.json().catch(() => ({}))) as { confirm?: unknown }
        const { slug } = await workspaces.get(workspaceId, userId)
        if (typeof body.confirm !== 'string' || body.confirm !== slug) {
          throw new ValidationError(
            `To erase this workspace, confirm with its slug: send { "confirm": "${slug}" }. This cannot be undone.`,
            { field: 'confirm' },
          )
        }
        const outcome = await erasure.erase({ workspaceId, actorId: userId })
        return c.json({ erased: true, ...outcome })
      },
    }),
  ]
}
