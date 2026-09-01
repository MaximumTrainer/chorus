import { describe, it, expect } from 'vitest'
import {
  ROLES,
  atLeast,
  effectivePermission,
  resolveRole,
  SCOPES,
  type Role,
  type Scope,
} from './permissions.js'

/**
 * WS-4 — roles, and the rule that a token's scope is a ceiling, never a floor.
 *
 * Launching a coding job spends money and writes to a repository, which is why
 * `senior_member` exists as a distinct rung rather than being folded into
 * `member`.
 */
describe('WS-4 role model', () => {
  it('WS-4: roles form a total order from member to owner', () => {
    expect(ROLES).toEqual(['member', 'senior_member', 'admin', 'owner'])
  })

  it('WS-4: a higher role satisfies a lower requirement', () => {
    expect(atLeast('owner', 'member')).toBe(true)
    expect(atLeast('admin', 'senior_member')).toBe(true)
    expect(atLeast('senior_member', 'senior_member')).toBe(true)
  })

  it('WS-4 AC1: a member does not satisfy a senior_member requirement', () => {
    expect(atLeast('member', 'senior_member')).toBe(false)
  })

  it('WS-4 AC2: a senior_member does not satisfy an admin requirement', () => {
    expect(atLeast('senior_member', 'admin')).toBe(false)
  })
})

describe('WS-4 AC3 team overrides', () => {
  it('WS-4 AC3: a team override raises the effective role in that team only', () => {
    const membership = { workspaceRole: 'member' as Role, teamOverrides: { 'team-a': 'senior_member' as Role } }
    expect(resolveRole(membership, 'team-a')).toBe('senior_member')
    expect(resolveRole(membership, 'team-b')).toBe('member')
  })

  it('WS-4 AC3: a team override can also lower the effective role', () => {
    const membership = { workspaceRole: 'admin' as Role, teamOverrides: { 'team-a': 'member' as Role } }
    expect(resolveRole(membership, 'team-a')).toBe('member')
  })

  it('WS-4: with no team in context, the workspace role applies', () => {
    expect(resolveRole({ workspaceRole: 'admin', teamOverrides: {} })).toBe('admin')
  })
})

describe('WS-5 AC2 scope is a ceiling, not a floor', () => {
  const allScopes = [...SCOPES]

  it('WS-5 AC2: a token cannot grant more than the user already has', () => {
    // A member holding a run:coding token still may not launch a job.
    const decision = effectivePermission({
      role: 'member',
      tokenScopes: allScopes,
      required: { role: 'senior_member', scopes: ['run:coding'] },
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('role')
  })

  it('WS-5 AC2: a sufficient role still needs the scope', () => {
    const decision = effectivePermission({
      role: 'senior_member',
      tokenScopes: ['read:artefacts'],
      required: { role: 'senior_member', scopes: ['run:coding'] },
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('scope')
    expect(decision.missingScopes).toEqual(['run:coding'])
  })

  it('WS-5: role and scope together permit the action', () => {
    expect(
      effectivePermission({
        role: 'senior_member',
        tokenScopes: ['run:coding'],
        required: { role: 'senior_member', scopes: ['run:coding'] },
      }).allowed,
    ).toBe(true)
  })

  it('WS-5: a session with no token is unrestricted by scope, since scope only narrows', () => {
    expect(
      effectivePermission({
        role: 'admin',
        tokenScopes: undefined,
        required: { role: 'admin', scopes: ['write:artefacts'] },
      }).allowed,
    ).toBe(true)
  })

  it('WS-5: every required scope must be present, not merely one of them', () => {
    const decision = effectivePermission({
      role: 'admin',
      tokenScopes: ['read:artefacts'],
      required: { role: 'member', scopes: ['read:artefacts', 'write:artefacts'] },
    })
    expect(decision.allowed).toBe(false)
    expect(decision.missingScopes).toEqual(['write:artefacts'])
  })

  it('WS-5: an unknown scope on a token grants nothing', () => {
    const decision = effectivePermission({
      role: 'admin',
      tokenScopes: ['not:a:real:scope' as Scope],
      required: { role: 'member', scopes: ['read:artefacts'] },
    })
    expect(decision.allowed).toBe(false)
  })

  it('WS-4: a denial always names which check failed, so a misconfiguration is diagnosable', () => {
    for (const role of ROLES) {
      const decision = effectivePermission({
        role,
        tokenScopes: [],
        required: { role: 'owner', scopes: ['read:artefacts'] },
      })
      if (!decision.allowed) expect(['role', 'scope']).toContain(decision.reason)
    }
  })
})
