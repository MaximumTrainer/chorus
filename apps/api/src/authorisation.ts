import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  decideAccess,
  ulid,
  type Role,
  type Scope,
} from '@chorus/core'
import { withTenant, type DbConfig } from '@chorus/db'
import type { AppContext, RouteDefinition } from './routes.js'
import type { WorkspaceService } from './workspaces.js'
import type { TeamService } from './teams.js'
import type { ApiTokenService } from './api-tokens.js'
import type { OAuthService } from './oauth.js'

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
  readonly tokens: ApiTokenService
  readonly oauth: OAuthService
  readonly dbConfig: DbConfig
}

/**
 * The bearer credential presented, if any.
 *
 * Parsed here rather than in a global middleware because a personal token is
 * workspace-scoped (WS-5), and only a route's own declaration tells us which
 * workspace is in scope. A middleware mounted by path pattern has no
 * parameters, and guessing the workspace from the URL is exactly the sort of
 * second implementation that comes to disagree with the first.
 */
function bearerToken(c: AppContext): string | undefined {
  const header = c.req.header('authorization')
  if (!header) return undefined
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer') return undefined
  const value = rest.join(' ').trim()
  return value === '' ? undefined : value
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

    if (definition.auth.kind === 'capability') {
      // No session is required, and none is consulted. The route verifies its
      // own credential, because only it knows what the token is bound to — a
      // check here could only ask "is this string a token", which is the least
      // useful half of the question.
      await next()
      return
    }

    const session = c.get('user')

    if (definition.auth.kind === 'authenticated') {
      // No workspace is named, so a workspace-scoped personal token cannot be
      // resolved here (WS-5). These are the routes a person uses to choose
      // where to work, not the ones a script calls.
      if (!session) throw new UnauthenticatedError('Sign in to continue')
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

    // A session takes precedence: a first-party caller is unrestricted by
    // scope, and a token presented alongside one would only ever narrow them
    // by accident.
    let user = session
    let tokenScopes: readonly Scope[] | undefined
    if (!user) {
      const presented = bearerToken(c)
      if (presented) {
        // A personal token and an OAuth access token are the same kind of
        // caller once resolved — a user, in this workspace, narrowed by scope.
        // They are told apart by their scheme, so neither can be honoured as
        // the other.
        const credential =
          (await deps.tokens.resolve(workspaceId, presented)) ??
          (await deps.oauth.resolveAccessToken(workspaceId, presented))
        if (credential) {
          user = { id: credential.userId, email: credential.email }
          tokenScopes = credential.scopes
        }
      }
    }

    if (!user) throw new UnauthenticatedError('Sign in to continue')

    const workspaceRole = await deps.workspaces.roleOf(workspaceId, user.id)

    const teamId = c.req.param('teamId')
    const effectiveRole =
      workspaceRole && teamId
        ? await deps.teams.roleIn(workspaceId, teamId, user.id, workspaceRole)
        : workspaceRole

    const decision = decideAccess({ auth: definition.auth, user, role: effectiveRole, tokenScopes })

    if (decision.outcome === 'not_found') {
      throw new NotFoundError('No such workspace', { workspaceId })
    }

    // A session-only route reached with a token (WS-5 AC2). The credential is
    // not one this route accepts, so it is answered as unauthenticated: a wider
    // scope would not have helped, and 403 would suggest it might.
    if (decision.outcome === 'unauthenticated') {
      throw new UnauthenticatedError('This action requires an interactive session', {
        reason: 'session_required',
      })
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
      throw new ForbiddenError(
        decision.reason === 'scope'
          ? `This token is missing the ${decision.missingScopes?.join(', ')} scope`
          : `This action requires the ${decision.required} role`,
        {
          required: decision.required,
          held: decision.held,
          reason: decision.reason,
          ...(decision.missingScopes ? { missingScopes: decision.missingScopes } : {}),
        },
      )
    }

    c.set('user', user)
    c.set('workspaceRole', workspaceRole!)
    c.set('effectiveRole', effectiveRole!)
    await next()
  }
}
