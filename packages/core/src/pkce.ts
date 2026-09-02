import { createHash } from 'node:crypto'
import { constantTimeEquals } from './tokens.js'
import type { Scope } from './permissions.js'

/**
 * Proof Key for Code Exchange (WS-5 AC3), and the words a consent screen shows.
 *
 * Both live in `core` because the authorization server issues the challenge and
 * the MCP server will describe the same scopes; two implementations of "does
 * this verifier match" is one implementation too many for a check whose whole
 * job is to be exact.
 */

/**
 * S256 only. OAuth 2.1 removes `plain`, and rightly: with `plain` the challenge
 * carried in the authorization request *is* the verifier, so anyone who can see
 * the request can complete the exchange — which is the attack PKCE exists to
 * stop. A client may still ask for `plain`; it is refused rather than honoured.
 */
export const CODE_CHALLENGE_METHODS = ['S256'] as const
export type CodeChallengeMethod = (typeof CODE_CHALLENGE_METHODS)[number]

/** RFC 7636 §4.1. A shorter verifier is brute-forceable from its challenge. */
const MIN_VERIFIER_LENGTH = 43
const MAX_VERIFIER_LENGTH = 128

export function verifyCodeChallenge(
  verifier: string,
  challenge: string,
  method: string,
): boolean {
  if (!(CODE_CHALLENGE_METHODS as readonly string[]).includes(method)) return false
  if (challenge === '') return false
  if (verifier.length < MIN_VERIFIER_LENGTH || verifier.length > MAX_VERIFIER_LENGTH) return false

  const computed = createHash('sha256').update(verifier, 'ascii').digest('base64url')
  return constantTimeEquals(computed, challenge)
}

export interface DescribedScope {
  readonly scope: string
  /** What the holder of this scope may do, in words a person can consent to. */
  readonly description: string
}

/**
 * Scope strings are not a user interface. Nobody can meaningfully agree to
 * `run:coding`, so the consent screen shows these instead.
 */
const DESCRIPTIONS: Readonly<Record<Scope, string>> = Object.freeze({
  'read:artefacts': 'Read your documents, tasks and the decisions recorded against them',
  'write:artefacts': 'Create and change documents and tasks on your behalf',
  'run:coding': 'Start coding jobs, which write code and open pull requests',
  'read:brain': 'Read what your workspace has learnt from your tools and conversations',
})

export function describeScopes(scopes: readonly string[]): DescribedScope[] {
  return scopes.map((scope) => ({
    scope,
    // An unknown scope is described rather than dropped: showing a person a
    // shorter list than they are agreeing to is worse than showing an
    // unfamiliar one.
    description:
      DESCRIPTIONS[scope as Scope] ?? 'An unrecognised permission — do not approve this request',
  }))
}
