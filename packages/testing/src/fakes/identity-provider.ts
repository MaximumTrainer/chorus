import { createHash } from 'node:crypto'
import { UpstreamError, type ExternalIdentityProvider, type LinkableProvider } from '@chorus/core'

/**
 * A scriptable external identity provider (CLAUDE.md §4, NFR-4).
 *
 * Stands in for Atlassian's sign-in when a user links their account. It is
 * faithful where the security of the flow lives: it remembers the PKCE
 * challenges it was shown and refuses an exchange whose verifier does not hash
 * to one of them, and it records every exchange — so a test can assert that a
 * code was never exchanged on behalf of the wrong person.
 */
export interface FakeIdentityProvider extends ExternalIdentityProvider {
  /** Every code exchange attempted, in order, and whether its verifier matched a challenge. */
  readonly exchanges: ReadonlyArray<{ readonly code: string; readonly verifierMatched: boolean }>
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function createFakeIdentityProvider(input: {
  readonly provider: LinkableProvider
  /** Which account each authorization code proves. An unknown code is refused. */
  readonly accounts: Readonly<Record<string, string>>
}): FakeIdentityProvider {
  const challenges = new Set<string>()
  const exchanges: Array<{ code: string; verifierMatched: boolean }> = []

  return {
    provider: input.provider,
    exchanges,
    authorizationUrl({ state, codeChallenge, redirectUri }) {
      challenges.add(codeChallenge)
      const url = new URL(`https://identity.fake/${input.provider}/authorize`)
      url.searchParams.set('state', state)
      url.searchParams.set('code_challenge', codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('redirect_uri', redirectUri)
      return url.toString()
    },
    async accountIdFor({ code, codeVerifier }) {
      const verifierMatched = challenges.has(s256(codeVerifier))
      exchanges.push({ code, verifierMatched })
      if (!verifierMatched) throw new UpstreamError('The PKCE verifier did not match any challenge issued')
      const accountId = input.accounts[code]
      if (!accountId) throw new UpstreamError('The authorization code was not recognised')
      return accountId
    },
  }
}
