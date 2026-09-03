import { effectivePermission, type Role, type Scope } from './permissions.js'

/**
 * The access decision (WS-4 AC4, AC5).
 *
 * Every route and every MCP tool declares what it requires as *data*. This
 * function turns that declaration plus a caller into an outcome, and it is the
 * only place that mapping exists. Making the requirement declarative is only
 * worth anything if the declaration is also what enforces — a declaration
 * inspected by a CI check while a hand-written check inside the handler does
 * the real work reads as a guarantee, is not one, and the two drift the first
 * time someone edits only the handler.
 *
 * It lives in `core` rather than in the API because AC5 requires the permitted
 * set over MCP to be identical to the permitted set over HTTP. One decision
 * makes that true by construction; two would make it something to re-verify
 * forever, and nobody clicks through MCP, so a divergence there is a
 * privilege-escalation bug nobody notices.
 */

export type AuthRequirement =
  /** Deliberately unauthenticated. `reason` makes that a decision, not an omission. */
  | { readonly kind: 'public'; readonly reason: string }
  /**
   * Authenticated by something that is not a session: a single-use token in an
   * email, and later a signed action from a chat surface.
   *
   * Deliberately its own kind rather than `public`. A route reached with a
   * capability token is not unauthenticated, and filing it under `public`
   * would put it in the same bucket as `/healthz` — where the enumeration gate
   * would stop being able to tell the two apart, which is precisely the
   * distinction that gate exists to police. `credential` names what is
   * presented, so the route table can be read as a list of every non-session
   * way into the system.
   *
   * The requirement is only that a credential exists and is named here; the
   * route itself verifies it, because only the route knows what the token is
   * bound to.
   */
  | {
      readonly kind: 'capability'
      readonly credential: string
      readonly reason: string
    }
  /**
   * A session is required but membership is not, because there is no workspace
   * in scope yet — creating your first workspace cannot require belonging to
   * one. `reason` is required for the same purpose it serves on `public`.
   */
  | {
      readonly kind: 'authenticated'
      readonly reason: string
      readonly scopes: readonly Scope[]
    }
  | {
      readonly kind: 'workspace'
      readonly role: Role
      readonly scopes: readonly Scope[]
      /**
       * Refuses any machine credential, whatever its scope (WS-5 AC2).
       *
       * Reserved for operations that mint or widen a credential. A token that
       * can issue another token has no ceiling: an admin's read-only token
       * would simply issue itself a full one, and the scope it was created
       * with would mean nothing.
       */
      readonly sessionOnly?: boolean
    }

export interface AccessRequest {
  readonly auth: AuthRequirement
  /** Absent when the caller presented no usable credential. */
  readonly user?: { readonly id: string; readonly email: string } | undefined
  /**
   * The role the caller effectively holds here — the workspace role, or the
   * team override where one applies. Absent means "not a member".
   */
  readonly role?: Role | undefined
  /**
   * Scopes carried by an API token. `undefined` means a first-party session,
   * which is unrestricted by scope — scope only ever narrows.
   */
  readonly tokenScopes?: readonly Scope[] | undefined
}

export type AccessDecision =
  | { readonly outcome: 'allow' }
  | { readonly outcome: 'unauthenticated' }
  /**
   * Not a member. Answered as not-found rather than forbidden: confirming that
   * a workspace exists would let anyone enumerate them by id (WS-2 AC4).
   */
  | { readonly outcome: 'not_found' }
  | {
      readonly outcome: 'forbidden'
      readonly required: Role
      readonly held: Role
      /** Which check failed, so a denial is diagnosable rather than a shrug. */
      readonly reason: 'role' | 'scope'
      readonly missingScopes?: readonly Scope[]
    }

export function decideAccess(request: AccessRequest): AccessDecision {
  if (request.auth.kind === 'public') return { outcome: 'allow' }

  // The route verifies the capability itself, since only it knows what the
  // token is bound to. What this decides is that no *session* is required.
  if (request.auth.kind === 'capability') return { outcome: 'allow' }

  if (!request.user) return { outcome: 'unauthenticated' }

  if (request.auth.kind === 'authenticated') return { outcome: 'allow' }

  if (!request.role) return { outcome: 'not_found' }

  // Answered as unauthenticated rather than forbidden: the credential is not
  // one this route accepts at all, so the remedy is to present a different one
  // — not to acquire a wider scope, which would not help.
  if (request.auth.sessionOnly && request.tokenScopes !== undefined) {
    return { outcome: 'unauthenticated' }
  }

  const decision = effectivePermission({
    role: request.role,
    tokenScopes: request.tokenScopes,
    required: { role: request.auth.role, scopes: request.auth.scopes },
  })

  if (decision.allowed) return { outcome: 'allow' }

  return {
    outcome: 'forbidden',
    required: request.auth.role,
    held: request.role,
    reason: decision.reason,
    ...(decision.missingScopes ? { missingScopes: decision.missingScopes } : {}),
  }
}
