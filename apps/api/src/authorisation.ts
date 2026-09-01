import { ForbiddenError, NotFoundError, UnauthenticatedError, atLeast, type Role } from '@chorus/core'
import type { AppContext } from './routes.js'
import type { WorkspaceService } from './workspaces.js'

/**
 * The two checks every workspace-scoped route makes (WS-2, WS-3).
 *
 * Written once because they encode a security decision, not a convenience: a
 * caller who is not a member is answered with *not-found*, never forbidden.
 * Confirming that a workspace exists would let anyone enumerate them by id
 * (WS-2 AC4), and that is exactly the sort of rule that decays when each route
 * module keeps its own copy.
 */

export function requireUser(c: AppContext): { id: string; email: string } {
  const user = c.get('user')
  if (!user) throw new UnauthenticatedError('Sign in to continue')
  return user
}

export async function requireRole(
  c: AppContext,
  workspaces: WorkspaceService,
  workspaceId: string,
  minimum: Role,
): Promise<{ userId: string; role: Role }> {
  const user = requireUser(c)
  const role = await workspaces.roleOf(workspaceId, user.id)

  // Not a member: indistinguishable from a workspace that does not exist.
  if (!role) throw new NotFoundError('No such workspace', { workspaceId })

  if (!atLeast(role, minimum)) {
    throw new ForbiddenError(`This action requires the ${minimum} role`, {
      required: minimum,
      held: role,
    })
  }
  return { userId: user.id, role }
}
