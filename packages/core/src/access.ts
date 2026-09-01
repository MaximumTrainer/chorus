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
   * A session is required but membership is not, because there is no workspace
   * in scope yet — creating your first workspace cannot require belonging to
   * one. `reason` is required for the same purpose it serves on `public`.
   */
  | {
      readonly kind: 'authenticated'
      readonly reason: string
      readonly scopes: readonly Scope[]
    }
  | { readonly kind: 'workspace'; readonly role: Role; readonly scopes: readonly Scope[] }

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

  if (!request.user) return { outcome: 'unauthenticated' }

  if (request.auth.kind === 'authenticated') return { outcome: 'allow' }

  if (!request.role) return { outcome: 'not_found' }

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
