import {
  OAUTH_SCHEMES,
  SCOPES,
  UnauthenticatedError,
  looksLikeApiToken,
  parseScopedSecret,
} from '@chorus/core'
import { caller } from './authorisation.js'
import type { McpEndpoint } from './mcp.js'
import { route, type AppContext, type RouteDefinition } from './routes.js'

/**
 * The MCP endpoint's routes (MCP-1, architecture.md §14).
 *
 * Two doors to one server. `/mcp` is the address a client is given, and it
 * serves OAuth access tokens, which name the workspace they were granted for.
 * A personal API token names no workspace, so a script uses
 * `/workspaces/{workspaceId}/mcp`, which accepts either credential.
 *
 * `/mcp` does no authorisation of its own. It reads the workspace out of the
 * token and hands the request to the workspace door, so there is exactly one
 * place a caller's role and scopes are checked and one place a refusal is
 * audited — the same middleware every other route uses. A second check here
 * would be a second implementation of WS-4, and AC5 of MCP-5 exists because
 * those drift.
 */

/** Whether a path is one of the MCP endpoints, for the 401 challenge. */
export function isMcpPath(path: string): boolean {
  return path === '/mcp' || /^\/workspaces\/[^/]+\/mcp$/.test(path)
}

/**
 * The challenge a 401 carries on an MCP endpoint (RFC 9728 §5.1).
 *
 * This header is how a client that has never seen the server finds out where
 * to authenticate. Without it a client falls back to guessing well-known URLs
 * at the origin, which works here by coincidence and would stop working the
 * moment the API sat under a path prefix.
 */
export function mcpChallenge(baseUrl: string, path: string): string {
  return `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource${path}"`
}

function bearer(c: AppContext): string | undefined {
  const header = c.req.header('authorization')
  const [scheme, ...rest] = (header ?? '').split(' ')
  if (scheme?.toLowerCase() !== 'bearer') return undefined
  const value = rest.join(' ').trim()
  return value === '' ? undefined : value
}

/** RFC 9728 metadata for one MCP resource. */
function resourceMetadata(baseUrl: string, path: string) {
  return {
    // Must equal the URL the client connected to: the SDK refuses metadata
    // describing some other resource, which is the check that stops one server
    // collecting tokens meant for another.
    resource: `${baseUrl}${path}`,
    authorization_servers: [baseUrl],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Chorus',
  }
}

export function mcpRoutes(
  endpoint: McpEndpoint,
  /** Hands a rewritten request back to the app, so it is authorised as any other. */
  dispatch: (request: Request) => Promise<Response>,
): readonly RouteDefinition[] {
  const workspaceDoor = (c: AppContext) =>
    endpoint.handle(c.req.raw, {
      userId: caller(c).userId,
      workspaceId: c.req.param('workspaceId')!,
    })

  /**
   * `/mcp`: find the workspace in the access token and go through the
   * workspace door with it.
   */
  const oauthDoor = async (c: AppContext): Promise<Response> => {
    const token = bearer(c)
    if (!token) throw new UnauthenticatedError('An access token is required')

    const scoped = parseScopedSecret(OAUTH_SCHEMES.access, token)
    if (!scoped) {
      // Said outright rather than left as a bare 401. A script author holding
      // a valid personal token would otherwise conclude it had been revoked.
      throw new UnauthenticatedError(
        looksLikeApiToken(token)
          ? 'A personal API token names no workspace, so it cannot be used at /mcp. ' +
              'Connect to /workspaces/{workspaceId}/mcp instead.'
          : 'An OAuth access token is required at /mcp',
      )
    }

    const url = new URL(c.req.url)
    url.pathname = `/workspaces/${scoped.workspaceId}/mcp`
    const method = c.req.method
    // Read, not streamed through: a request body is a one-shot stream, and a
    // copy that shares it with the original is a copy that may find it empty.
    const body = method === 'POST' ? await c.req.raw.text() : undefined
    return dispatch(
      new Request(url, { method, headers: c.req.raw.headers, ...(body === undefined ? {} : { body }) }),
    )
  }

  const oauthAuth = {
    kind: 'capability',
    credential: 'oauth_access_token',
    reason:
      'The workspace is named by the access token rather than the path, so the route reads it ' +
      'from the token and hands the request to /workspaces/:workspaceId/mcp, which authorises it.',
  } as const

  const workspaceAuth = {
    kind: 'workspace',
    // Connecting grants nothing by itself: each tool declares its own role and
    // scopes (MCP-5), exactly as each HTTP route does. So the door asks only
    // that the caller belongs here.
    role: 'member',
    scopes: [],
  } as const

  const publicMetadata = {
    kind: 'public',
    reason: 'Discovery is how a client learns where to authenticate; it precedes any credential.',
  } as const

  return [
    route({
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      summary: 'RFC 9728 metadata for the MCP endpoint.',
      auth: publicMetadata,
      handler: (c) => c.json(resourceMetadata(c.get('baseUrl'), '/mcp')),
    }),
    route({
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/workspaces/:workspaceId/mcp',
      summary: "RFC 9728 metadata for a workspace's MCP endpoint.",
      auth: publicMetadata,
      handler: (c) =>
        c.json(
          resourceMetadata(c.get('baseUrl'), `/workspaces/${c.req.param('workspaceId')}/mcp`),
        ),
    }),

    route({
      method: 'POST',
      path: '/mcp',
      summary: 'MCP Streamable HTTP, for OAuth clients.',
      auth: oauthAuth,
      handler: oauthDoor,
    }),
    route({
      method: 'GET',
      path: '/mcp',
      summary: 'MCP Streamable HTTP server stream, for OAuth clients (not offered yet).',
      auth: oauthAuth,
      handler: oauthDoor,
    }),
    route({
      method: 'DELETE',
      path: '/mcp',
      summary: 'Ends an MCP session, for OAuth clients.',
      auth: oauthAuth,
      handler: oauthDoor,
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/mcp',
      summary: 'MCP Streamable HTTP, for OAuth clients and personal API tokens.',
      auth: workspaceAuth,
      handler: workspaceDoor,
    }),
    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/mcp',
      summary: 'MCP Streamable HTTP server stream (not offered yet).',
      auth: workspaceAuth,
      handler: workspaceDoor,
    }),
    route({
      method: 'DELETE',
      path: '/workspaces/:workspaceId/mcp',
      summary: 'Ends an MCP session.',
      auth: workspaceAuth,
      handler: workspaceDoor,
    }),
  ]
}
