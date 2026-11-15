/**
 * Linking a Chorus user to their own account at an external source (NFR-4 AC1).
 *
 * Restricted content from a source reaches a Chorus user only through an
 * account at that source the user has *proved they own* — an explicit link,
 * never a match on email (decided 2026-11-13). Proof is an OAuth authorization
 * code flow with PKCE: the user signs in at the source, and the source tells us
 * which account signed in.
 *
 * A port in `core`, like `GitHost` and `Sandbox`: the API runs the flow, a
 * connector package implements it against the real source, and a fake in
 * `packages/testing` stands in for it in tests.
 */

/** The sources a user can link an account at. */
export const LINKABLE_PROVIDERS = ['atlassian'] as const
export type LinkableProvider = (typeof LINKABLE_PROVIDERS)[number]

export function isLinkableProvider(value: string): value is LinkableProvider {
  return (LINKABLE_PROVIDERS as readonly string[]).includes(value)
}

/**
 * The scope sources an account at a provider grants. Unlinking an account
 * revokes the user's memberships from exactly these sources, at once (AND1).
 */
export const PROVIDER_SCOPE_SOURCES: Readonly<Record<LinkableProvider, readonly string[]>> = {
  atlassian: ['confluence', 'jira'],
}

export interface ExternalIdentityProvider {
  readonly provider: LinkableProvider
  /**
   * Where to send the user to sign in. `state` must come back unchanged on the
   * callback; `codeChallenge` is the S256 challenge of a verifier only the
   * server holds.
   */
  authorizationUrl(input: { readonly state: string; readonly codeChallenge: string; readonly redirectUri: string }): string
  /**
   * Exchange the code the source sent back, with the PKCE verifier, and answer
   * the id of the account that signed in. Only the account id is kept; the
   * tokens obtained to learn it are discarded.
   */
  accountIdFor(input: {
    readonly code: string
    readonly codeVerifier: string
    readonly redirectUri: string
  }): Promise<string>
}
