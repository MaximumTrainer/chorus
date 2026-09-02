import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { isUlid } from './ids.js'

/**
 * Personal API tokens (WS-5 AC1).
 *
 * The minting and storage rules live here, in `core`, because the API issues
 * tokens and the MCP server will accept them, and a second implementation of
 * "what a valid token looks like" is how one front door comes to accept
 * something the other would refuse.
 *
 * Only a hash and a display prefix are ever persisted. The plaintext exists in
 * exactly two places: the response to the request that created it, and wherever
 * its holder chose to keep it.
 */

/**
 * A recognisable scheme, so a leaked token can be found by a secret scanner and
 * so a value that is plainly not ours is refused before it is hashed and looked
 * up — an unrecognised credential should cost nothing to reject.
 */
export const API_TOKEN_SCHEME = 'chorus_pat_'

/**
 * The displayed prefix: the scheme plus the first eight characters of the
 * secret. Enough to tell two of your own tokens apart in a list, far too little
 * to reconstruct one.
 */
export const API_TOKEN_PREFIX_LENGTH = API_TOKEN_SCHEME.length + 8

/** 32 bytes, base64url-encoded: 256 bits of entropy in 43 characters. */
const SECRET_BYTES = 32

export interface MintedApiToken {
  /** Returned to the creator once, and never stored. */
  readonly plaintext: string
  /** What is stored in `api_tokens.token_hash`. */
  readonly hash: string
  /** What is stored in `api_tokens.token_prefix` and shown in listings. */
  readonly prefix: string
}

export function mintApiToken(): MintedApiToken {
  const plaintext = `${API_TOKEN_SCHEME}${randomBytes(SECRET_BYTES).toString('base64url')}`
  return { plaintext, hash: hashApiToken(plaintext), prefix: apiTokenPrefix(plaintext) }
}

/**
 * SHA-256, unsalted and deliberately fast.
 *
 * A password needs a slow, salted hash because it is short, human-chosen and
 * reused. A token is 256 bits of machine randomness, so a dictionary attack has
 * nothing to work with and a per-token salt would only prevent the lookup by
 * hash that authentication depends on.
 */
export function hashApiToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

export function apiTokenPrefix(plaintext: string): string {
  return plaintext.slice(0, API_TOKEN_PREFIX_LENGTH)
}

/** Cheap structural rejection, before a value is hashed or sent to the database. */
export function looksLikeApiToken(value: string): boolean {
  return (
    value.startsWith(API_TOKEN_SCHEME) &&
    value.length >= API_TOKEN_SCHEME.length + 43 &&
    !/\s/.test(value)
  )
}

/**
 * Length-independent equality.
 *
 * `timingSafeEqual` throws on a length mismatch, and a caller comparing a
 * presented value has no control over its length — so the lengths are compared
 * first and the result folded in, rather than short-circuiting on them.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) {
    // Still do the work, against a same-length buffer, so the refusal takes the
    // same time whatever the mismatch was.
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

/**
 * The three OAuth secret kinds (WS-5 AC3, AC4).
 *
 * Distinct schemes so a value cannot be honoured as something it is not: an
 * access token relabelled as a refresh token would defeat rotation without ever
 * touching the rotation code.
 */
export const OAUTH_SCHEMES = Object.freeze({
  code: 'chorus_ac_',
  access: 'chorus_at_',
  refresh: 'chorus_rt_',
})

export interface ScopedSecret {
  readonly plaintext: string
  readonly hash: string
}

/**
 * A secret that names the workspace it belongs to.
 *
 * The token endpoint has no workspace in its path, so a refresh token presented
 * there could not otherwise be looked up inside a tenant context. The
 * alternative is a row-level security policy widened enough to find a token
 * without one — a hole in the boundary NFR-3 rests on, opened in order to
 * authenticate, which is precisely the wrong trade.
 *
 * The workspace id is not a secret; it appears in every URL the client calls.
 * It is inside the hashed span, so editing it yields a value matching no row.
 */
export function mintScopedSecret(scheme: string, workspaceId: string): ScopedSecret {
  const plaintext = `${scheme}${workspaceId}.${randomBytes(SECRET_BYTES).toString('base64url')}`
  return { plaintext, hash: hashApiToken(plaintext) }
}

export function parseScopedSecret(
  scheme: string,
  presented: string,
): { workspaceId: string; hash: string } | undefined {
  if (!presented.startsWith(scheme)) return undefined

  const body = presented.slice(scheme.length)
  const separator = body.indexOf('.')
  if (separator <= 0) return undefined

  const workspaceId = body.slice(0, separator)
  const secret = body.slice(separator + 1)
  // A malformed id is refused here rather than becoming a tenant context that
  // matches nothing and an error nobody can read.
  if (!isUlid(workspaceId) || secret.length === 0) return undefined

  return { workspaceId, hash: hashApiToken(presented) }
}
