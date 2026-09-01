import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  decideAccess,
  ulid,
  type Role,
} from '@chorus/core'
import { withTenant, type DbConfig } from '@chorus/db'
import type { AppContext, RouteDefinition } from './routes.js'
import type { WorkspaceService } from './workspaces.js'
import type { TeamService } from './teams.js'

/**
 * Authorisation, driven by the route's own declaration (WS-4 AC4).
 *
 * Before this, every handler called `requireRole` by hand and the declared
 * `auth` was inspected only by a CI check. That is the worst arrangement
 * available: it reads as a guarantee, is not one, and the two drift the first
 * time somebody edits a handler without editing its declaration. Here the
 * declaration *is* the enforcement, so a route can be wrong — and that is
 * testable — but it can no longer disagree with itself.
 *
 * Handlers therefore never re-derive identity or role; they read what this
 * middleware resolved.
 */

export interface AuthorisationDeps {
  readonly workspaces: WorkspaceService
  readonly teams: TeamService
  readonly dbConfig: DbConfig
}

/** The caller, as resolved by the middleware. Absent only if a route bypassed it. */
export function caller(c: AppContext): { userId: string; email: string; role: Role } {
  const user = c.get('user')
  const role = c.get('effectiveRole')
  if (!user || !role) {
    // A programming error, not a user error: this route was mounted without
    // authorisation, which the route table is meant to make impossible.
    throw new Error('caller() used on a route with no resolved workspace role')
  }
  return { userId: user.id, email: user.email, role }
}

/** The caller on a route that requires a session but no membership. */
export function signedIn(c: AppContext): { userId: string; email: string } {
  const user = c.get('user')
  if (!user) throw new UnauthenticatedError('Sign in to continue')
  return { userId: user.id, email: user.email }
}

/**
 * Records a refusal, so a misconfigured permission is diagnosable rather than
 * an unexplained 403 that nobody can tell was correct.
 *
 * Only written when the caller *is* a member. A non-member is answered
 * not-found, and writing their attempt into that workspace's trail would let
 * anyone append rows to any workspace's audit log by guessing ids — turning a
 * denial into an amplification vector.
 */
async function recordDenial(
  dbConfig: DbConfig,
  input: {
    workspaceId: string
    userId: string
    method: string
    path: string
    required: Role
    held: Role
  },
): Promise<void> {
  try {
    await withTenant(
      input.workspaceId,
      async (tx) => {
        await tx.execute(
          `INSERT INTO audit_events
             (id, workspace_id, actor_type, actor_id, action, target_type, target_id, after)
           VALUES ($1, $2, 'user', $3, 'access.denied', 'route', $4, $5)`,
          [
            ulid(),
            input.workspaceId,
            input.userId,
            `${input.method} ${input.path}`,
            JSON.stringify({
              method: input.method,
              path: input.path,
              required: input.required,
              held: input.held,
            }),
          ],
        )
      },
      { config: dbConfig, userId: input.userId },
    )
  } catch (error) {
    // Ordering, not swallowing: the refusal itself must still reach the caller
    // as a 403 rather than becoming a 500 because the trail was unwritable.
    console.error(
      JSON.stringify({ level: 'error', message: 'could not record access denial', error: String(error) }),
    )
  }
}

/**
 * The middleware for one route, built from its declaration.
 *
 * Resolution order matters: the workspace role establishes membership, and a
 * team override then replaces it for routes that name a team. An override
 * replaces rather than raises, so a workspace admin can be deliberately
 * restricted inside a sensitive team (WS-4 AC3).
 */
export function authorise(definition: RouteDefinition, deps: AuthorisationDeps) {
  return async (c: AppContext, next: () => Promise<void>): Promise<void> => {
    if (definition.auth.kind === 'public') {
      await next()
      return
    }

    const user = c.get('user')
    if (!user) throw new UnauthenticatedError('Sign in to continue')

    if (definition.auth.kind === 'authenticated') {
      await next()
      return
    }

    const workspaceId = c.req.param('workspaceId')
    if (!workspaceId) {
      // The permission suite asserts this cannot happen; failing loudly beats
      // defaulting to "allow" if it ever does.
      throw new Error(
        `${definition.method} ${definition.path} requires a workspace role but names no workspace`,
      )
    }

    const workspaceRole = await deps.workspaces.roleOf(workspaceId, user.id)

    const teamId = c.req.param('teamId')
    const effectiveRole =
      workspaceRole && teamId
        ? await deps.teams.roleIn(workspaceId, teamId, user.id, workspaceRole)
        : workspaceRole

    const decision = decideAccess({ auth: definition.auth, user, role: effectiveRole })

    if (decision.outcome === 'not_found') {
      throw new NotFoundError('No such workspace', { workspaceId })
    }

    if (decision.outcome === 'forbidden') {
      await recordDenial(deps.dbConfig, {
        workspaceId,
        userId: user.id,
        method: definition.method,
        path: definition.path,
        required: decision.required,
        held: decision.held,
      })
      throw new ForbiddenError(`This action requires the ${decision.required} role`, {
        required: decision.required,
        held: decision.held,
      })
    }

    c.set('workspaceRole', workspaceRole!)
    c.set('effectiveRole', effectiveRole!)
    await next()
  }
}
