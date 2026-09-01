import type { Context } from 'hono'

/**
 * The route table (WS-4 AC4).
 *
 * Authorisation is declared as *data* on each route rather than as a check
 * inside its handler, so it can be enumerated. A forgotten check then becomes
 * impossible: a route can be wrong, but it cannot be silently unguarded.
 * test/nfr/route-authorisation.test.ts enumerates this table on every pull
 * request, so a new route appears there without anyone remembering to add it.
 */

export type Role = 'member' | 'senior_member' | 'admin' | 'owner'
export type Scope = 'read:artefacts' | 'write:artefacts' | 'run:coding' | 'read:brain'

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
    mailer?: MailSender
    baseUrl: string
  }
}

export type AppContext = Context<AppEnv>

export type AuthRequirement =
  /** Deliberately unauthenticated. `reason` makes that a decision, not an omission. */
  | { readonly kind: 'public'; readonly reason: string }
  | { readonly kind: 'workspace'; readonly role: Role; readonly scopes: readonly Scope[] }

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
