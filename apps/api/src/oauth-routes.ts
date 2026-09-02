import { CODE_CHALLENGE_METHODS, SCOPES, describeScopes } from '@chorus/core'
import { route, type AppContext, type RouteDefinition } from './routes.js'
import { caller, signedIn } from './authorisation.js'
import { OAuthError, type OAuthService, type PendingAuthorization } from './oauth.js'
import type { WorkspaceService } from './workspaces.js'

/**
 * The OAuth 2.1 authorization server's endpoints (WS-5 AC3, AC4, AC5).
 *
 * The protocol endpoints are declared `public` because they must be: a client
 * that has never been registered has no credential to present, and the token
 * endpoint authenticates the *client*, by its own rules, not the caller. Each
 * says so in its `reason`, so "public" here is a decision the route-authorisation
 * suite can read rather than an omission.
 *
 * The two consent endpoints require a session and no membership — a person
 * signs in, and *then* chooses which workspace they are granting access to, so
 * requiring membership before the choice would be circular.
 */

/**
 * Client names arrive through dynamic registration, which anyone may perform.
 * Rendering one unescaped would let a registrant put script into a consent
 * screen — the one page whose whole purpose is that the reader trusts it.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** A body that may arrive as JSON or as an HTML form post. */
async function readBody(c: AppContext): Promise<Record<string, string>> {
  const contentType = c.req.header('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return (await c.req.json().catch(() => ({}))) as Record<string, string>
  }
  const form = await c.req.raw.clone().formData().catch(() => undefined)
  if (!form) return {}
  return Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]))
}

function redirectWith(target: string, params: Record<string, string | null>): Response {
  const url = new URL(target)
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value)
  }
  return new Response(null, { status: 302, headers: { location: url.toString() } })
}

function oauthProblem(error: OAuthError): Response {
  return new Response(JSON.stringify({ error: error.code, error_description: error.message }), {
    status: error.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function consentPage(
  request: PendingAuthorization,
  workspaces: ReadonlyArray<{ id: string; name: string }>,
): string {
  const scopes = describeScopes(request.scopes)
    .map((entry) => `      <li>${escapeHtml(entry.description)}</li>`)
    .join('\n')

  const options = workspaces
    .map((w) => `        <option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`)
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Authorise ${escapeHtml(request.client.clientName)}</title></head>
<body>
  <main>
    <h1>${escapeHtml(request.client.clientName)} wants access to your workspace</h1>
    <p>If you approve, it will be able to:</p>
    <ul>
${scopes}
    </ul>
    <form method="post" action="/oauth/authorize">
      <input type="hidden" name="request_id" value="${escapeHtml(request.id)}">
      <label for="workspaceId">Workspace</label>
      <select id="workspaceId" name="workspaceId">
${options}
      </select>
      <button type="submit" name="decision" value="approve">Approve</button>
      <button type="submit" name="decision" value="deny">Cancel</button>
    </form>
  </main>
</body>
</html>
`
}

export function oauthRoutes(
  oauth: OAuthService,
  workspaces: WorkspaceService,
  issuerOf: (c: AppContext) => string,
): RouteDefinition[] {
  return [
    route({
      method: 'GET',
      path: '/.well-known/oauth-authorization-server',
      summary: 'RFC 8414 metadata, so a client can bootstrap unattended.',
      auth: {
        kind: 'public',
        reason: 'Discovery is how a client learns where to authenticate; it precedes any credential.',
      },
      handler: (c) => {
        const issuer = issuerOf(c)
        return c.json({
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
          registration_endpoint: `${issuer}/oauth/register`,
          scopes_supported: [...SCOPES],
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: [...CODE_CHALLENGE_METHODS],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        })
      },
    }),

    route({
      method: 'POST',
      path: '/oauth/register',
      summary: 'RFC 7591 dynamic client registration.',
      auth: {
        kind: 'public',
        reason: 'Registration is how a client obtains its first credential, so it can present none.',
      },
      handler: async (c) => {
        try {
          const registered = await oauth.registerClient(await c.req.json().catch(() => ({})))
          return c.json(
            {
              client_id: registered.clientId,
              client_name: registered.clientName,
              redirect_uris: registered.redirectUris,
              grant_types: registered.grantTypes,
              response_types: registered.responseTypes,
              token_endpoint_auth_method: registered.tokenEndpointAuthMethod,
              client_id_issued_at: registered.issuedAt,
              ...(registered.clientSecret ? { client_secret: registered.clientSecret } : {}),
            },
            201,
          )
        } catch (error) {
          if (error instanceof OAuthError) return oauthProblem(error)
          throw error
        }
      },
    }),

    route({
      method: 'GET',
      path: '/oauth/authorize',
      summary: 'Show the consent screen for an authorization request.',
      auth: {
        kind: 'authenticated',
        reason: 'The granter must be signed in, but chooses the workspace here — so membership cannot be required yet.',
        scopes: [],
      },
      handler: async (c) => {
        const user = signedIn(c)
        const query = c.req.query()

        try {
          const request = await oauth.beginAuthorization({
            clientId: query.client_id ?? '',
            userId: user.userId,
            redirectUri: query.redirect_uri ?? '',
            scope: query.scope ?? '',
            codeChallenge: query.code_challenge ?? '',
            codeChallengeMethod: query.code_challenge_method ?? '',
            responseType: query.response_type ?? '',
            ...(query.state ? { state: query.state } : {}),
          })

          const mine = await workspaces.listFor(user.userId)
          return c.html(consentPage(request, mine))
        } catch (error) {
          // Deliberately answered here rather than by redirecting: until the
          // client and its redirect URI have both been validated, the only
          // place we could redirect to is one the caller supplied, which is an
          // open redirect.
          if (error instanceof OAuthError) return oauthProblem(error)
          throw error
        }
      },
    }),

    route({
      method: 'POST',
      path: '/oauth/authorize',
      summary: 'Record the consent decision and redirect back to the client.',
      auth: {
        kind: 'authenticated',
        reason: 'The decision belongs to the signed-in granter; the workspace is named in the body.',
        scopes: [],
      },
      handler: async (c) => {
        const user = signedIn(c)
        const body = await readBody(c)
        const requestId = body.requestId ?? body.request_id ?? ''

        if (body.decision === 'deny') {
          const { redirectUri, state } = await oauth.deny(requestId, user.userId)
          return redirectWith(redirectUri, { error: 'access_denied', state })
        }

        const { code, redirectUri, state } = await oauth.approve(
          requestId,
          user.userId,
          body.workspaceId ?? '',
        )
        return redirectWith(redirectUri, { code, state })
      },
    }),

    route({
      method: 'POST',
      path: '/oauth/token',
      summary: 'Exchange an authorization code, or rotate a refresh token.',
      auth: {
        kind: 'public',
        reason: 'The token endpoint authenticates the client by its own rules, not by a session.',
      },
      handler: async (c) => {
        const body = await readBody(c)
        try {
          const tokens =
            body.grant_type === 'refresh_token'
              ? await oauth.refresh({
                  clientId: body.client_id ?? '',
                  ...(body.client_secret ? { clientSecret: body.client_secret } : {}),
                  refreshToken: body.refresh_token ?? '',
                })
              : body.grant_type === 'authorization_code'
                ? await oauth.exchangeCode({
                    clientId: body.client_id ?? '',
                    ...(body.client_secret ? { clientSecret: body.client_secret } : {}),
                    code: body.code ?? '',
                    codeVerifier: body.code_verifier ?? '',
                    redirectUri: body.redirect_uri ?? '',
                  })
                : (() => {
                    throw new OAuthError(
                      'unsupported_grant_type',
                      `Unsupported grant type: ${body.grant_type ?? '(none)'}`,
                    )
                  })()

          return new Response(
            JSON.stringify({
              access_token: tokens.accessToken,
              refresh_token: tokens.refreshToken,
              token_type: 'Bearer',
              expires_in: tokens.expiresIn,
              scope: tokens.scopes.join(' '),
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
            },
          )
        } catch (error) {
          if (error instanceof OAuthError) return oauthProblem(error)
          throw error
        }
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/grants',
      summary: 'List the OAuth grants the caller has given in this workspace.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'], sessionOnly: true },
      handler: async (c) =>
        c.json(await oauth.listGrants(c.req.param('workspaceId'), caller(c).userId)),
    }),

    route({
      method: 'DELETE',
      path: '/workspaces/:workspaceId/grants/:grantId',
      summary: 'Revoke an OAuth grant, with immediate effect.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'], sessionOnly: true },
      handler: async (c) => {
        await oauth.revokeGrant(
          c.req.param('workspaceId'),
          caller(c).userId,
          c.req.param('grantId'),
        )
        return c.body(null, 204)
      },
    }),
  ]
}
