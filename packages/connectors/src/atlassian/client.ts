import { RateLimitedError, UpstreamError } from '@chorus/core'
import type { ConnectorContext } from '../contract.js'

/**
 * The HTTP client shared by the Atlassian connectors (INT-8, INT-9).
 *
 * Jira and Confluence authenticate identically — an Atlassian OAuth 2.0 Bearer
 * token with a refresh token that rotates on every use — and surface the same
 * rate-limit and error shapes. Copying that into each connector guarantees the
 * two token-refresh paths drift, which is the one failure nobody sees until a
 * refresh silently stops working, so it lives here once. Only the content
 * converters differ between the products; this does not.
 */

export const ATLASSIAN_OAUTH = 'https://auth.atlassian.com/oauth/token'

export interface AtlassianClientOptions {
  /** Injected for tests; the connector's own `ctx.fetch` otherwise. */
  readonly fetch?: typeof fetch
  /** The product API base, e.g. `https://api.atlassian.com/ex/jira/<cloudId>`. */
  readonly apiUrl: string
  readonly clientId?: string
  readonly clientSecret?: string
  /** The product name, used in error messages (`Jira`, `Confluence`). */
  readonly product: string
  /** Pulls a human reason out of the product's error body; raw text otherwise. */
  readonly reason?: (raw: string) => string
}

export interface AtlassianClient {
  /** One authenticated request, refreshing once on a 401. */
  request(method: string, path: string, body: unknown, ctx: ConnectorContext): Promise<Response>
  /** One authenticated GET, parsed as JSON. */
  get(path: string, ctx: ConnectorContext): Promise<Record<string, unknown>>
  /** Refresh the access token, persisting the rotated refresh token. */
  refresh(ctx: ConnectorContext): Promise<string | undefined>
}

export function createAtlassianClient(options: AtlassianClientOptions): AtlassianClient {
  const api = options.apiUrl.replace(/\/$/, '')
  const reason = options.reason ?? ((raw: string) => raw.slice(0, 200) || 'no body')

  async function refresh(ctx: ConnectorContext): Promise<string | undefined> {
    const refreshToken = ctx.credentials.refreshToken
    if (!refreshToken || !options.clientId) return undefined
    const http = options.fetch ?? ctx.fetch
    const response = await http(ATLASSIAN_OAUTH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: options.clientId,
        ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
      }),
    })
    if (!response.ok) return undefined
    const granted = (await response.json()) as { access_token?: string; refresh_token?: string }
    if (!granted.access_token) return undefined
    await ctx.saveCredentials({
      ...ctx.credentials,
      accessToken: granted.access_token,
      // Atlassian rotates the refresh token; persist the new one or the next
      // refresh fails with nothing in the logs to explain it.
      ...(granted.refresh_token ? { refreshToken: granted.refresh_token } : {}),
    })
    return granted.access_token
  }

  async function request(
    method: string,
    path: string,
    body: unknown,
    ctx: ConnectorContext,
  ): Promise<Response> {
    const http = options.fetch ?? ctx.fetch
    const send = (token: string) =>
      http(`${api}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })

    let response = await send(ctx.credentials.accessToken ?? '')
    if (response.status === 401) {
      const refreshed = await refresh(ctx)
      if (refreshed) response = await send(refreshed)
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after')
      throw new RateLimitedError(`${options.product} applied a rate limit`, {
        retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : 60_000,
        status: 429,
      })
    }
    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      throw new UpstreamError(`${options.product} responded ${response.status}: ${reason(raw)}`, {
        status: response.status,
        body: raw.slice(0, 500),
      })
    }
    return response
  }

  async function get(path: string, ctx: ConnectorContext): Promise<Record<string, unknown>> {
    const response = await request('GET', path, undefined, ctx)
    return (await response.json()) as Record<string, unknown>
  }

  return { request, get, refresh }
}
