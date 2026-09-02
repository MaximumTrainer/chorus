import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { CODE_CHALLENGE_METHODS, describeScopes, verifyCodeChallenge } from './pkce.js'
import { SCOPES } from './permissions.js'

/**
 * WS-5 AC3 — proof of possession, and the words a person consents to.
 *
 * Both are pure, and both are the sort of thing that is wrong in a way no
 * integration test would notice: a challenge check that accepts everything
 * still lets the happy path pass.
 */
describe('WS-5 PKCE', () => {
  const challengeFor = (verifier: string): string =>
    createHash('sha256').update(verifier, 'ascii').digest('base64url')

  it('WS-5 AC3: a verifier matching its challenge is accepted', () => {
    const verifier = randomBytes(32).toString('base64url')
    expect(verifyCodeChallenge(verifier, challengeFor(verifier), 'S256')).toBe(true)
  })

  it('WS-5 AC3: a verifier that does not match is refused', () => {
    const verifier = randomBytes(32).toString('base64url')
    const other = randomBytes(32).toString('base64url')

    expect(verifyCodeChallenge(other, challengeFor(verifier), 'S256')).toBe(false)
    expect(verifyCodeChallenge('', challengeFor(verifier), 'S256')).toBe(false)
    // A one-character difference must not survive.
    expect(verifyCodeChallenge(verifier, `${challengeFor(verifier).slice(0, -1)}x`, 'S256')).toBe(
      false,
    )
  })

  it('WS-5 AC3: `plain` is refused, whatever the client asks for', () => {
    // OAuth 2.1 removes it. Accepting it would mean a challenge intercepted in
    // the authorization request *is* the verifier, which defeats the whole
    // mechanism — and a client can always ask.
    const verifier = randomBytes(32).toString('base64url')
    expect(verifyCodeChallenge(verifier, verifier, 'plain')).toBe(false)
    expect(CODE_CHALLENGE_METHODS).toEqual(['S256'])
  })

  it('WS-5 AC3: a challenge is required — an absent one never verifies', () => {
    // The failure mode this guards is a code issued with no challenge at all,
    // which would then be exchangeable by anyone who intercepted it.
    expect(verifyCodeChallenge('anything', '', 'S256')).toBe(false)
  })

  it('WS-5 AC3: a verifier outside the specified length range is refused', () => {
    // RFC 7636 §4.1: 43–128 characters. A short verifier is brute-forceable
    // from the challenge, so the bound is a security property, not tidiness.
    const short = 'a'.repeat(42)
    const long = 'a'.repeat(129)
    expect(verifyCodeChallenge(short, challengeFor(short), 'S256')).toBe(false)
    expect(verifyCodeChallenge(long, challengeFor(long), 'S256')).toBe(false)

    const shortest = 'a'.repeat(43)
    expect(verifyCodeChallenge(shortest, challengeFor(shortest), 'S256')).toBe(true)
  })
})

describe('WS-5 scope descriptions', () => {
  it('WS-5: every scope the system defines has a plain-language description', () => {
    // A scope with no description would reach a consent screen as its
    // identifier, and a person cannot consent to `run:coding`.
    const described = describeScopes(SCOPES)
    expect(described).toHaveLength(SCOPES.length)
    for (const entry of described) {
      expect(entry.description.length, `${entry.scope} needs a real description`).toBeGreaterThan(15)
      expect(entry.description, 'a description must not just be the scope').not.toContain(':')
    }
  })

  it('WS-5: an unknown scope is described rather than dropped', () => {
    // Dropping it would show a person a shorter list than they are agreeing to.
    const [entry] = describeScopes(['read:invented'] as never)
    expect(entry!.description.length).toBeGreaterThan(0)
  })

  it('WS-5: descriptions come back in the order the scopes were asked for', () => {
    expect(describeScopes(['run:coding', 'read:artefacts']).map((e) => e.scope)).toEqual([
      'run:coding',
      'read:artefacts',
    ])
  })
})
