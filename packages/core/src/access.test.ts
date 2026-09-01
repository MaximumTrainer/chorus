import { describe, it, expect } from 'vitest'
import { ROLES, type Role } from './permissions.js'
import { decideAccess, type AccessDecision, type AuthRequirement } from './access.js'

/**
 * WS-4 AC4, AC5 — the access decision, made once.
 *
 * Both front doors consume this: the HTTP middleware and, from WP-1.11, the MCP
 * server. AC5 requires the permitted sets to be identical, and the only way to
 * guarantee that rather than periodically verify it is for there to be one
 * decision. Nobody clicks through MCP, so a divergence there is a
 * privilege-escalation bug that goes unnoticed.
 */

const workspaceRoute = (role: Role): AuthRequirement => ({
  kind: 'workspace',
  role,
  scopes: ['read:artefacts'],
})

function outcomeOf(decision: AccessDecision): string {
  return decision.outcome
}

describe('WS-4 access decision', () => {
  it('WS-4 AC4: a public route admits everyone, signed in or not', () => {
    const auth: AuthRequirement = { kind: 'public', reason: 'Health is polled without credentials.' }
    expect(outcomeOf(decideAccess({ auth }))).toBe('allow')
    expect(outcomeOf(decideAccess({ auth, user: { id: 'u', email: 'a@b.test' } }))).toBe('allow')
  })

  it('WS-4 AC4: an authenticated route needs a session but no membership', () => {
    // Creating your first workspace cannot require membership of one.
    const auth: AuthRequirement = {
      kind: 'authenticated',
      reason: 'Creating a workspace precedes belonging to one.',
      scopes: ['write:artefacts'],
    }
    expect(outcomeOf(decideAccess({ auth }))).toBe('unauthenticated')
    expect(outcomeOf(decideAccess({ auth, user: { id: 'u', email: 'a@b.test' } }))).toBe('allow')
  })

  it('WS-4 AC4: a workspace route refuses an anonymous caller before looking at roles', () => {
    expect(outcomeOf(decideAccess({ auth: workspaceRoute('member') }))).toBe('unauthenticated')
  })

  it('WS-4: a non-member is answered not-found, never forbidden', () => {
    // Forbidden would confirm the workspace exists, which lets anyone
    // enumerate workspaces by id (WS-2 AC4).
    const decision = decideAccess({
      auth: workspaceRoute('member'),
      user: { id: 'u', email: 'a@b.test' },
    })
    expect(outcomeOf(decision)).toBe('not_found')
  })

  it('WS-4 AC4: a member holding the required role or better is allowed', () => {
    for (const required of ROLES) {
      for (const held of ROLES) {
        const decision = decideAccess({
          auth: workspaceRoute(required),
          user: { id: 'u', email: 'a@b.test' },
          role: held,
        })
        const shouldAllow = ROLES.indexOf(held) >= ROLES.indexOf(required)
        expect(
          outcomeOf(decision),
          `${held} against a required ${required}`,
        ).toBe(shouldAllow ? 'allow' : 'forbidden')
      }
    }
  })

  it('WS-4: a refusal names what was required and what was held, so it is diagnosable', () => {
    const decision = decideAccess({
      auth: workspaceRoute('admin'),
      user: { id: 'u', email: 'a@b.test' },
      role: 'member',
    })
    expect(decision).toMatchObject({ outcome: 'forbidden', required: 'admin', held: 'member' })
  })

  it('WS-4 AC5: a token scope narrows what its holder may do, and never widens it', () => {
    // A `run:coding` token held by a member still cannot launch a job.
    const readOnly = decideAccess({
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      user: { id: 'u', email: 'a@b.test' },
      role: 'owner',
      tokenScopes: ['read:artefacts'],
    })
    expect(readOnly).toMatchObject({ outcome: 'forbidden', reason: 'scope' })

    const widened = decideAccess({
      auth: { kind: 'workspace', role: 'admin', scopes: ['read:artefacts'] },
      user: { id: 'u', email: 'a@b.test' },
      role: 'member',
      tokenScopes: ['read:artefacts', 'write:artefacts', 'run:coding', 'read:brain'],
    })
    expect(widened, 'a generous token must not raise a role').toMatchObject({
      outcome: 'forbidden',
      reason: 'role',
    })
  })

  it('WS-4: a first-party session carries no scopes and is limited by role alone', () => {
    const decision = decideAccess({
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts', 'run:coding'] },
      user: { id: 'u', email: 'a@b.test' },
      role: 'member',
    })
    expect(outcomeOf(decision)).toBe('allow')
  })

  it('WS-4: the decision is pure — the same inputs always give the same outcome', () => {
    const request = {
      auth: workspaceRoute('admin'),
      user: { id: 'u', email: 'a@b.test' },
      role: 'member' as Role,
    }
    expect(decideAccess(request)).toEqual(decideAccess(request))
  })
})
