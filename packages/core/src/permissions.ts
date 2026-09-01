/**
 * Roles and permission resolution (WS-4, WS-5).
 *
 * Implemented once, here, and consumed by both the HTTP middleware and the MCP
 * server. Two implementations would diverge, and a divergence between those two
 * front doors is a privilege-escalation bug that nobody notices, because nobody
 * clicks through MCP (MCP-5 AC1).
 */

/** Ordered from least to most privileged. The order *is* the comparison. */
export const ROLES = ['member', 'senior_member', 'admin', 'owner'] as const
export type Role = (typeof ROLES)[number]

export const SCOPES = ['read:artefacts', 'write:artefacts', 'run:coding', 'read:brain'] as const
export type Scope = (typeof SCOPES)[number]

const RANK: Readonly<Record<Role, number>> = Object.freeze(
  Object.fromEntries(ROLES.map((role, index) => [role, index])) as Record<Role, number>,
)

/** Does `held` meet or exceed `required`? */
export function atLeast(held: Role, required: Role): boolean {
  return RANK[held] >= RANK[required]
}

export interface Membership {
  readonly workspaceRole: Role
  /** Per-team overrides. An override *replaces* the workspace role, up or down. */
  readonly teamOverrides: Readonly<Record<string, Role>>
}

/**
 * The role a user holds in a given team.
 *
 * An override replaces rather than raises: a workspace admin may be deliberately
 * restricted to `member` in a sensitive team, and a rule that only ever raised
 * would make that impossible to express.
 */
export function resolveRole(membership: Membership, teamId?: string): Role {
  if (teamId) {
    const override = membership.teamOverrides[teamId]
    if (override) return override
  }
  return membership.workspaceRole
}

export interface PermissionRequest {
  readonly role: Role
  /**
   * Scopes carried by the API token, if any. `undefined` means a first-party
   * session, which is unrestricted by scope — scope only ever narrows.
   */
  readonly tokenScopes?: readonly Scope[] | undefined
  readonly required: {
    readonly role: Role
    readonly scopes: readonly Scope[]
  }
}

export type PermissionDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false
      /** Which check failed, so a denial is diagnosable rather than a shrug. */
      readonly reason: 'role' | 'scope'
      readonly missingScopes?: readonly Scope[]
    }

/**
 * Effective permission is the intersection of the user's role and the token's
 * scope. A token can only ever narrow what its holder may already do — a
 * `run:coding` token held by a `member` still cannot launch a job (WS-5 AC2).
 */
export function effectivePermission(request: PermissionRequest): PermissionDecision {
  if (!atLeast(request.role, request.required.role)) {
    return { allowed: false, reason: 'role' }
  }

  // A first-party session carries no scopes and is limited by role alone.
  if (request.tokenScopes === undefined) {
    return { allowed: true }
  }

  const held = new Set(request.tokenScopes)
  const missingScopes = request.required.scopes.filter((scope) => !held.has(scope))

  return missingScopes.length === 0
    ? { allowed: true }
    : { allowed: false, reason: 'scope', missingScopes }
}
