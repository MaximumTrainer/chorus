import type { Context } from 'hono'
import type { AuthRequirement, Role } from '@chorus/core'

/**
 * The route table (WS-4 AC4).
 *
 * Authorisation is declared as *data* on each route rather than as a check
 * inside its handler, so it can be enumerated. A forgotten check then becomes
 * impossible: a route can be wrong, but it cannot be silently unguarded.
 * test/nfr/route-authorisation.test.ts enumerates this table on every pull
 * request, so a new route appears there without anyone remembering to add it.
 */

// One definition of each, in core, because the MCP server declares its tools
// against the same types and AC5 requires the two permitted sets to be equal.
export type { Role, Scope, AuthRequirement } from '@chorus/core'

export interface ReadinessResult {
  readonly ready: boolean
  readonly reason?: string
}

/**
 * Request-scoped values. Declared here so `c.get`/`c.set` are type-checked:
 * an untyped context is how a typo becomes an `undefined` at runtime.
 */
export interface AuthenticatedUser {
  readonly id: string
  readonly email: string
}

export interface MailSender {
  send(message: { to: string; subject: string; text: string; html?: string }): Promise<void>
}

export interface AppEnv {
  Variables: {
    requestId: string
    checkReadiness: () => Promise<ReadinessResult>
    /** Absent when the caller is unauthenticated. */
    user?: AuthenticatedUser
    /**
     * The role the caller holds in the workspace named by the path, and the
     * role they effectively hold once a team override is applied. Both are set
     * by the authorisation middleware, so a handler never re-derives them —
     * re-deriving is how a handler comes to disagree with its own declaration.
     */
    workspaceRole?: Role
    effectiveRole?: Role
    mailer?: MailSender
    baseUrl: string
  }
}

export type AppContext = Context<AppEnv>

export interface RouteDefinition {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  readonly path: string
  readonly auth: AuthRequirement
  readonly handler: (c: AppContext) => Response | Promise<Response>
  /** Short description, surfaced in the generated OpenAPI document. */
  readonly summary: string
}

/** Helper so a route definition reads as a sentence. */
export function route(definition: RouteDefinition): RouteDefinition {
  return definition
}
