import { describe, it, expect } from 'vitest'
import { UpstreamError } from '@chorus/core'
import { createAtlassianIdentity } from '../../src/atlassian/identity.js'
import { cassettePlayer } from '../../src/testing/cassettes.js'

/**
 * NFR-4 AC1 — proving which Atlassian account a person owns.
 *
 * The person signs in at Atlassian; the code Atlassian sends back is exchanged,
 * and Atlassian's `/me` names the account that signed in. Only that account id
 * leaves this module — the tokens obtained to learn it are not returned, so
 * nothing upstream can keep them. The request asks for `read:me` and nothing
 * more: this is proof of identity, not delegated access.
 */
const options = { clientId: 'chorus-client', clientSecret: 'chorus-secret' }

describe('NFR-4 Atlassian identity', () => {
  it('NFR-4 AC1: the sign-in URL asks only for identity, carries the state, and a PKCE challenge', () => {
    const identity = createAtlassianIdentity(options)
    const url = new URL(
      identity.authorizationUrl({ state: 'ws.random', codeChallenge: 'challenge', redirectUri: 'https://chorus.test/cb' }),
    )

    expect(url.origin + url.pathname).toBe('https://auth.atlassian.com/authorize')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      audience: 'api.atlassian.com',
      client_id: 'chorus-client',
      scope: 'read:me',
      redirect_uri: 'https://chorus.test/cb',
      state: 'ws.random',
      response_type: 'code',
      prompt: 'consent',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
    })
  })

  it('NFR-4 AC1: a sign-in code names the Atlassian account that signed in, and nothing else', async () => {
    const identity = createAtlassianIdentity({ ...options, fetch: cassettePlayer('atlassian/identity-link.json') })
    const accountId = await identity.accountIdFor({
      code: 'code-from-atlassian',
      codeVerifier: 'verifier',
      redirectUri: 'https://chorus.test/cb',
    })
    expect(accountId).toBe('5b10ac8d82e05b22cc7d4ef5')
  })

  it('NFR-4 AC1: a code Atlassian refuses names no account', async () => {
    const identity = createAtlassianIdentity({ ...options, fetch: cassettePlayer('atlassian/identity-rejected.json') })
    await expect(
      identity.accountIdFor({ code: 'stale', codeVerifier: 'verifier', redirectUri: 'https://chorus.test/cb' }),
    ).rejects.toBeInstanceOf(UpstreamError)
  })
})
