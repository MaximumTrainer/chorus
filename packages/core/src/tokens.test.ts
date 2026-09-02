import { describe, it, expect } from 'vitest'
import {
  API_TOKEN_SCHEME,
  API_TOKEN_PREFIX_LENGTH,
  OAUTH_SCHEMES,
  apiTokenPrefix,
  constantTimeEquals,
  hashApiToken,
  looksLikeApiToken,
  mintApiToken,
  mintScopedSecret,
  parseScopedSecret,
} from './tokens.js'

/**
 * WS-5 AC1 — token minting, hashing and prefix derivation.
 *
 * The properties asserted here are the ones a leaked database depends on: the
 * stored form must not be reversible, the displayed form must not be usable,
 * and comparison must not leak the answer through its own timing.
 */
describe('WS-5 personal API tokens', () => {
  it('WS-5 AC1: a minted token is scheme-prefixed and unguessably long', () => {
    const token = mintApiToken()

    expect(token.plaintext.startsWith(API_TOKEN_SCHEME)).toBe(true)
    // 32 bytes of entropy, base64url-encoded. Shorter is brute-forceable; the
    // assertion is on the secret half so the scheme cannot pad it out.
    expect(token.plaintext.slice(API_TOKEN_SCHEME.length).length).toBeGreaterThanOrEqual(43)
  })

  it('WS-5 AC1: two mints never collide', () => {
    const minted = new Set(Array.from({ length: 200 }, () => mintApiToken().plaintext))
    expect(minted.size).toBe(200)
  })

  it('WS-5 AC1: the stored hash is not the token, and does not contain it', () => {
    const token = mintApiToken()

    expect(token.hash).not.toBe(token.plaintext)
    expect(token.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(token.hash).not.toContain(token.plaintext.slice(API_TOKEN_SCHEME.length))
  })

  it('WS-5 AC1: hashing is deterministic, so a presented token can be looked up', () => {
    const token = mintApiToken()

    expect(hashApiToken(token.plaintext)).toBe(token.hash)
    expect(hashApiToken(token.plaintext)).toBe(hashApiToken(token.plaintext))
  })

  it('WS-5 AC1: a one-character difference changes the hash entirely', () => {
    const hash = hashApiToken(`${API_TOKEN_SCHEME}aaaa`)
    const nearly = hashApiToken(`${API_TOKEN_SCHEME}aaab`)

    expect(nearly).not.toBe(hash)
    const shared = [...hash].filter((character, index) => character === nearly[index]).length
    // Two independent hex strings agree on about 1/16 of their characters. A
    // scheme that merely appended would agree on nearly all of them.
    expect(shared).toBeLessThan(24)
  })

  it('WS-5 AC1: the display prefix identifies a token without being usable as one', () => {
    const token = mintApiToken()

    expect(token.prefix).toBe(token.plaintext.slice(0, API_TOKEN_PREFIX_LENGTH))
    expect(token.prefix.length).toBe(API_TOKEN_PREFIX_LENGTH)
    // The point of a prefix is that it is short enough to be worthless. Most of
    // the entropy must remain undisclosed.
    expect(token.prefix.length).toBeLessThan(token.plaintext.length / 2)
    expect(apiTokenPrefix(token.plaintext)).toBe(token.prefix)
  })

  it('WS-5 AC1: comparison is constant-time and still correct', () => {
    const hash = hashApiToken(`${API_TOKEN_SCHEME}secret`)

    expect(constantTimeEquals(hash, hash)).toBe(true)
    expect(constantTimeEquals(hash, hashApiToken(`${API_TOKEN_SCHEME}other`))).toBe(false)
    // Differing lengths must answer false rather than throw: a caller comparing
    // a presented value has no control over its length.
    expect(constantTimeEquals(hash, '')).toBe(false)
    expect(constantTimeEquals('', '')).toBe(true)
  })

  it('WS-5: a value that is not one of ours is rejected before it is hashed', () => {
    expect(looksLikeApiToken(mintApiToken().plaintext)).toBe(true)
    expect(looksLikeApiToken('')).toBe(false)
    expect(looksLikeApiToken('Bearer something')).toBe(false)
    // A session cookie or an OAuth access token must not be mistaken for one.
    expect(looksLikeApiToken(`${API_TOKEN_SCHEME}short`)).toBe(false)
  })
})

/**
 * WS-5 AC3 — credentials that name their own tenant.
 *
 * The token endpoint has no workspace in its path, so a refresh token
 * presented there cannot be looked up inside a tenant context unless it says
 * which one it belongs to. The alternative — widening a row-level security
 * policy so a token can be found without one — would put a hole in the
 * boundary NFR-3 rests on, in order to authenticate.
 */
describe('WS-5 workspace-scoped secrets', () => {
  const workspaceId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

  it('WS-5 AC3: a minted secret carries its workspace and hashes as a whole', () => {
    const minted = mintScopedSecret(OAUTH_SCHEMES.access, workspaceId)

    expect(minted.plaintext.startsWith(OAUTH_SCHEMES.access)).toBe(true)
    expect(minted.plaintext).toContain(workspaceId)
    expect(minted.hash).toBe(hashApiToken(minted.plaintext))
  })

  it('WS-5 AC3: a presented secret parses back to its workspace and hash', () => {
    const minted = mintScopedSecret(OAUTH_SCHEMES.refresh, workspaceId)
    const parsed = parseScopedSecret(OAUTH_SCHEMES.refresh, minted.plaintext)

    expect(parsed).toEqual({ workspaceId, hash: minted.hash })
  })

  it('WS-5 AC3: a secret only parses under the scheme it was minted for', () => {
    const access = mintScopedSecret(OAUTH_SCHEMES.access, workspaceId)

    // An access token presented as a refresh token must not be honoured, or the
    // rotation guarantee is defeated by relabelling.
    expect(parseScopedSecret(OAUTH_SCHEMES.refresh, access.plaintext)).toBeUndefined()
    expect(parseScopedSecret(OAUTH_SCHEMES.access, access.plaintext)).toBeDefined()
  })

  it('WS-5 AC3: a malformed or tampered secret parses to nothing rather than throwing', () => {
    for (const bad of [
      '',
      'nonsense',
      OAUTH_SCHEMES.access,
      `${OAUTH_SCHEMES.access}${workspaceId}`,
      `${OAUTH_SCHEMES.access}${workspaceId}.`,
      `${OAUTH_SCHEMES.access}not-a-ulid.abcdef`,
    ]) {
      expect(parseScopedSecret(OAUTH_SCHEMES.access, bad), bad).toBeUndefined()
    }
  })

  it('WS-5 AC3: changing the workspace changes the hash, so it cannot be re-pointed', () => {
    const minted = mintScopedSecret(OAUTH_SCHEMES.access, workspaceId)
    const other = '01ARZ3NDEKTSV4RRFFQ69G5FB0'
    const repointed = minted.plaintext.replace(workspaceId, other)

    // The workspace is part of what is hashed, so an attacker who edits it
    // holds a value that matches no stored row.
    expect(parseScopedSecret(OAUTH_SCHEMES.access, repointed)!.hash).not.toBe(minted.hash)
  })

  it('WS-5: the three OAuth schemes are distinct', () => {
    const schemes = Object.values(OAUTH_SCHEMES)
    expect(new Set(schemes).size).toBe(schemes.length)
    for (const scheme of schemes) {
      expect(looksLikeApiToken(`${scheme}x`), 'no OAuth secret may pass as a personal token').toBe(
        false,
      )
    }
  })
})
