import {
  RateLimitedError,
  UpstreamError,
  type EntityCandidate,
  type Signal,
} from '@chorus/core'
import type {
  AuthSpec,
  Capabilities,
  Connector,
  ConnectorContext,
  HealthStatus,
  PullResult,
} from '../contract.js'
import { candidatesFor, issueToSignal, type JiraIssue } from './streams.js'

/**
 * The Jira source connector (INT-8).
 *
 * Jira is REST and the most structurally variable tracker in common use, so the
 * pull is a JQL search ordered by `updated`, resumed by an offset within a sync
 * and bounded by an `updated >= cursor` filter the sync supplies — incremental
 * by the field Jira actually changes, not by a page number that shifts under
 * inserts. Descriptions convert from ADF to Markdown at normalisation.
 *
 * Atlassian OAuth rotates its refresh token on every use, like GitLab, so a
 * refresh that did not persist the new token works once and then dies; the
 * connector hands the replacement back through `saveCredentials`.
 */

export interface JiraOptions {
  readonly fetch?: typeof fetch
  /** The Jira API base, e.g. `https://api.atlassian.com/ex/jira/<cloudId>`. */
  readonly apiUrl?: string
  readonly clientId?: string
  readonly clientSecret?: string
}

const DEFAULT_OAUTH = 'https://auth.atlassian.com/oauth/token'
const PAGE_SIZE = 50
const FIELDS = 'summary,description,status,issuetype,assignee,reporter,project,updated,parent'

interface Cursor {
  readonly startAt: number
}

function parseCursor(raw: string | null): Cursor {
  if (!raw) return { startAt: 0 }
  try {
    const parsed = JSON.parse(raw) as Partial<Cursor>
    return { startAt: typeof parsed.startAt === 'number' ? parsed.startAt : 0 }
  } catch {
    return { startAt: 0 }
  }
}

export function createJiraConnector(options: JiraOptions = {}): Connector {
  const api = (options.apiUrl ?? 'https://api.atlassian.com/ex/jira/cloud').replace(/\/$/, '')

  const auth: AuthSpec = {
    kind: 'oauth2',
    authorizationUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: DEFAULT_OAUTH,
    scopes: ['read:jira-work', 'read:jira-user', 'offline_access'],
  }
  const capabilities: Capabilities = { source: true }

  async function refresh(ctx: ConnectorContext): Promise<string | undefined> {
    const refreshToken = ctx.credentials.refreshToken
    if (!refreshToken || !options.clientId) return undefined
    const http = options.fetch ?? ctx.fetch
    const response = await http(DEFAULT_OAUTH, {
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

  /** One authenticated GET, with a single refresh-and-retry on a 401. */
  async function get(path: string, ctx: ConnectorContext): Promise<Record<string, unknown>> {
    const http = options.fetch ?? ctx.fetch
    const send = (token: string) =>
      http(`${api}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })

    let response = await send(ctx.credentials.accessToken ?? '')
    if (response.status === 401) {
      const refreshed = await refresh(ctx)
      if (refreshed) response = await send(refreshed)
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after')
      throw new RateLimitedError('Jira applied a rate limit', {
        retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : 60_000,
        status: 429,
      })
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new UpstreamError(`Jira responded ${response.status}`, {
        status: response.status,
        body: body.slice(0, 500),
      })
    }
    return (await response.json()) as Record<string, unknown>
  }

  const siteUrl = (ctx: ConnectorContext): string =>
    typeof ctx.config.siteUrl === 'string' ? ctx.config.siteUrl : 'https://example.atlassian.net'
  const restricted = (ctx: ConnectorContext): boolean => ctx.config.privateByDefault !== false
  const jqlFor = (ctx: ConnectorContext): string =>
    typeof ctx.config.jql === 'string' ? ctx.config.jql : 'order by updated asc'

  return {
    kind: 'jira',
    auth,
    capabilities,

    async pull(cursor: string | null, ctx: ConnectorContext): Promise<PullResult> {
      const { startAt } = parseCursor(cursor)
      const jql = encodeURIComponent(jqlFor(ctx))
      const data = await get(
        `/rest/api/3/search?jql=${jql}&startAt=${startAt}&maxResults=${PAGE_SIZE}&fields=${FIELDS}`,
        ctx,
      )
      const issues = Array.isArray(data.issues) ? (data.issues as JiraIssue[]) : []
      const total = typeof data.total === 'number' ? data.total : startAt + issues.length

      const signals = issues.map((issue) => issueToSignal(issue, siteUrl(ctx), restricted(ctx)))

      const consumed = startAt + issues.length
      // Null means caught up. Jira's search is offset-based, but the sync's
      // `updated >= cursor` JQL is what makes a resumed sync incremental; the
      // offset only walks the pages of one sync.
      const nextCursor = consumed >= total || issues.length === 0 ? null : JSON.stringify({ startAt: consumed })
      return { signals, nextCursor }
    },

    mapExternal(signal: Signal): readonly EntityCandidate[] {
      return candidatesFor(signal)
    },

    async health(ctx: ConnectorContext): Promise<HealthStatus> {
      try {
        await get('/rest/api/3/myself', ctx)
        return { state: 'ok', checkedAt: ctx.now() }
      } catch (error) {
        if (error instanceof RateLimitedError) {
          return {
            state: 'degraded',
            checkedAt: ctx.now(),
            problem: 'Jira is rate limiting this integration.',
            remedy: 'No action needed — syncing resumes automatically after the requested delay.',
          }
        }
        const status = (error as UpstreamError).details?.status
        if (status === 401) {
          return {
            state: 'failed',
            checkedAt: ctx.now(),
            problem: 'The Jira access token was rejected and could not be refreshed.',
            remedy: 'Reconnect Jira for this workspace; if access was revoked in Atlassian, grant it again there first.',
          }
        }
        return {
          state: 'degraded',
          checkedAt: ctx.now(),
          problem: `Jira did not answer a health check: ${(error as Error).message}`,
          remedy: 'No action needed yet — usually transient. Investigate if it persists.',
        }
      }
    },
  }
}
