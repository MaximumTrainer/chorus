import {
  ConfigurationError,
  NotFoundError,
  ValidationError,
  isLinkableProvider,
  type ExternalIdentityProvider,
  type LinkableProvider,
} from '@chorus/core'
import { route, type AppContext, type RouteDefinition } from './routes.js'
import { caller, signedIn } from './authorisation.js'
import type { LinkedAccountService } from './linked-accounts.js'

/**
 * A person linking their own account at a source (NFR-4 AC1, AND1).
 *
 * Starting and removing a link are `sessionOnly`: a link grants access to
 * restricted content, so it must be a person at a keyboard, never a token —
 * the same rule as minting a credential. The callback is reached by the
 * browser returning from the source's sign-in, so it has no workspace in its
 * path; it requires a session, and the service completes the request only for
 * the person who started it.
 */
export type IdentityProviders = Partial<Record<LinkableProvider, ExternalIdentityProvider>>

const DISPLAY: Record<LinkableProvider, string> = { atlassian: 'Atlassian' }

function providerFrom(c: AppContext): LinkableProvider {
  const provider = c.req.param('provider') ?? ''
  if (!isLinkableProvider(provider)) throw new NotFoundError(`No such account provider: ${provider}`, { provider })
  return provider
}

function identityFor(providers: IdentityProviders, provider: LinkableProvider): ExternalIdentityProvider {
  const identity = providers[provider]
  if (!identity) {
    throw new ConfigurationError(
      `Linking an ${DISPLAY[provider]} account is not configured: set CHORUS_${provider.toUpperCase()}_CLIENT_ID and CHORUS_${provider.toUpperCase()}_CLIENT_SECRET.`,
    )
  }
  return identity
}

const callbackUri = (c: AppContext, provider: LinkableProvider): string =>
  `${c.get('baseUrl').replace(/\/$/, '')}/oauth/${provider}/callback`

export function linkedAccountRoutes(service: LinkedAccountService, providers: IdentityProviders): RouteDefinition[] {
  return [
    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/me/linked-accounts/:provider',
      summary: 'Start linking your own account at a source; answers where to sign in.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'], sessionOnly: true },
      handler: async (c) => {
        const provider = providerFrom(c)
        const identity = identityFor(providers, provider)
        return c.json(
          await service.start({
            workspaceId: c.req.param('workspaceId'),
            userId: caller(c).userId,
            identity,
            redirectUri: callbackUri(c, provider),
          }),
        )
      },
    }),

    route({
      method: 'GET',
      path: '/oauth/:provider/callback',
      summary: 'Where the source returns after sign-in; completes a link for the person who started it.',
      auth: {
        kind: 'authenticated',
        reason:
          'The source redirects the browser here, so no workspace is in the path; the state names it, and only its starter can complete it.',
        scopes: [],
      },
      handler: async (c) => {
        const provider = providerFrom(c)
        const identity = identityFor(providers, provider)
        if (c.req.query('error')) {
          throw new ValidationError('Linking was cancelled at the source.', { field: 'error' })
        }
        const state = c.req.query('state') ?? ''
        const code = c.req.query('code') ?? ''
        const linked = await service.complete({
          state,
          code,
          userId: signedIn(c).userId,
          identity,
          redirectUri: callbackUri(c, provider),
        })
        return c.json({ linked })
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/me/linked-accounts',
      summary: 'The accounts you have linked in this workspace.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(await service.list({ workspaceId: c.req.param('workspaceId'), userId: caller(c).userId })),
    }),

    route({
      method: 'DELETE',
      path: '/workspaces/:workspaceId/me/linked-accounts/:provider',
      summary: 'Unlink your account at a source; the access it granted ends at once.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'], sessionOnly: true },
      handler: async (c) =>
        c.json(
          await service.unlink({
            workspaceId: c.req.param('workspaceId'),
            userId: caller(c).userId,
            provider: providerFrom(c),
          }),
        ),
    }),
  ]
}
