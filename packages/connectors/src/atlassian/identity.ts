import { UpstreamError, type ExternalIdentityProvider } from '@chorus/core'
import { ATLASSIAN_OAUTH } from './client.js'

/**
 * Proving which Atlassian account a person owns (NFR-4 AC1).
 *
 * The person signs in at Atlassian (OAuth 2.0 3LO); the code sent back is
 * exchanged with the client secret, and `/me` names the account that signed
 * in. Only `read:me` is requested — this is proof of identity, not delegated
 * access — and only the account id is returned: the access token obtained to
 * call `/me` goes no further than this function, so nothing can keep it.
 *
 * The PKCE challenge and verifier are sent as well. The client secret is what
 * authenticates the exchange for a confidential client; PKCE binds the code to
 * the request that started it, as defence in depth.
 */
export interface AtlassianIdentityOptions {
  readonly clientId: string
  readonly clientSecret: string
  readonly fetch?: typeof fetch
}

const AUTHORIZE_URL = 'https://auth.atlassian.com/authorize'
const ME_URL = 'https://api.atlassian.com/me'

/** A human reason from an Atlassian OAuth error body, never the body itself (it may echo a code). */
function oauthReason(body: unknown): string {
  const parsed = (body ?? {}) as { error?: unknown; error_description?: unknown }
  if (typeof parsed.error_description === 'string') return parsed.error_description
  if (typeof parsed.error === 'string') return parsed.error
  return 'no reason given'
}

export function createAtlassianIdentity(options: AtlassianIdentityOptions): ExternalIdentityProvider {
  const http = options.fetch ?? fetch

  return {
    provider: 'atlassian',

    authorizationUrl({ state, codeChallenge, redirectUri }) {
      const url = new URL(AUTHORIZE_URL)
      url.searchParams.set('audience', 'api.atlassian.com')
      url.searchParams.set('client_id', options.clientId)
      url.searchParams.set('scope', 'read:me')
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('state', state)
      url.searchParams.set('response_type', 'code')
      // Always ask: an account picker the person did not see is not proof they chose this account.
      url.searchParams.set('prompt', 'consent')
      url.searchParams.set('code_challenge', codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      return url.toString()
    },

    async accountIdFor({ code, codeVerifier, redirectUri }) {
      const tokenResponse = await http(ATLASSIAN_OAUTH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      })
      const tokenBody = (await tokenResponse.json().catch(() => ({}))) as { access_token?: unknown }
      if (!tokenResponse.ok || typeof tokenBody.access_token !== 'string') {
        throw new UpstreamError(`Atlassian refused the sign-in code: ${oauthReason(tokenBody)}`, {
          status: tokenResponse.status,
        })
      }

      const meResponse = await http(ME_URL, { headers: { authorization: `Bearer ${tokenBody.access_token}` } })
      const me = (await meResponse.json().catch(() => ({}))) as { account_id?: unknown }
      if (!meResponse.ok || typeof me.account_id !== 'string' || me.account_id === '') {
        throw new UpstreamError('Atlassian did not say which account signed in', { status: meResponse.status })
      }
      return me.account_id
    },
  }
}
