import { RateLimitedError, UpstreamError, type EntityCandidate, type Signal } from '@chorus/core'
import type {
  AuthSpec,
  Capabilities,
  Connector,
  ConnectorContext,
  HealthStatus,
  PullResult,
} from '../contract.js'
import { createAtlassianClient, ATLASSIAN_OAUTH } from '../atlassian/client.js'
import { candidatesFor, pageToSignal, type ConfluencePage } from './streams.js'

/**
 * The Confluence source connector (INT-9).
 *
 * Confluence shares Jira's Atlassian OAuth grant and HTTP client, so only the
 * content differs: pages and blog posts are pulled by a CQL search ordered by
 * `lastmodified`, resumed by an offset within a sync and bounded by the sync's
 * `lastmodified >= cursor` filter — incremental by the field Confluence changes,
 * not a page number that shifts under edits. Bodies are ADF, converted to
 * Markdown with macros resolved (ADR-0022). The sink and two-way sync are later
 * slices; this is the read side.
 */

export interface ConfluenceOptions {
  readonly fetch?: typeof fetch
  /** The Confluence API base, e.g. `https://api.atlassian.com/ex/confluence/<cloudId>`. */
  readonly apiUrl?: string
  readonly clientId?: string
  readonly clientSecret?: string
}

const PAGE_SIZE = 25
const EXPAND = 'space,version,history.createdBy,body.atlas_doc_format'

interface Cursor {
  readonly start: number
}

function parseCursor(raw: string | null): Cursor {
  if (!raw) return { start: 0 }
  try {
    const parsed = JSON.parse(raw) as Partial<Cursor>
    return { start: typeof parsed.start === 'number' ? parsed.start : 0 }
  } catch {
    return { start: 0 }
  }
}

/** Pull a human reason out of a Confluence error body. */
function confluenceReason(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { message?: unknown }
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message
  } catch {
    // Not JSON; fall through.
  }
  return raw.slice(0, 200) || 'no body'
}

export function createConfluenceConnector(options: ConfluenceOptions = {}): Connector {
  const api = (options.apiUrl ?? 'https://api.atlassian.com/ex/confluence/cloud').replace(/\/$/, '')

  const auth: AuthSpec = {
    kind: 'oauth2',
    authorizationUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: ATLASSIAN_OAUTH,
    scopes: ['read:confluence-content.all', 'read:confluence-space.summary', 'offline_access'],
  }
  const capabilities: Capabilities = { source: true }

  const client = createAtlassianClient({
    apiUrl: api,
    product: 'Confluence',
    reason: confluenceReason,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.clientId ? { clientId: options.clientId } : {}),
    ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
  })
  const get = client.get

  const siteUrl = (ctx: ConnectorContext): string =>
    typeof ctx.config.siteUrl === 'string' ? ctx.config.siteUrl : 'https://example.atlassian.net'
  const restricted = (ctx: ConnectorContext): boolean => ctx.config.privateByDefault !== false
  const cqlFor = (ctx: ConnectorContext): string =>
    typeof ctx.config.cql === 'string' ? ctx.config.cql : 'type in (page, blogpost) order by lastmodified asc'

  return {
    kind: 'confluence',
    auth,
    capabilities,

    async pull(cursor: string | null, ctx: ConnectorContext): Promise<PullResult> {
      const { start } = parseCursor(cursor)
      const cql = encodeURIComponent(cqlFor(ctx))
      const data = await get(
        `/wiki/rest/api/content/search?cql=${cql}&limit=${PAGE_SIZE}&start=${start}&expand=${EXPAND}`,
        ctx,
      )
      const results = Array.isArray(data.results) ? (data.results as ConfluencePage[]) : []
      const signals = results.map((page) => pageToSignal(page, siteUrl(ctx), restricted(ctx)))

      // A short page is the last page. The sync's `lastmodified >= cursor` CQL is
      // what makes a resumed sync incremental; the offset only walks one sync.
      const nextCursor = results.length < PAGE_SIZE || results.length === 0
        ? null
        : JSON.stringify({ start: start + results.length })
      return { signals, nextCursor }
    },

    mapExternal(signal: Signal): readonly EntityCandidate[] {
      return candidatesFor(signal)
    },

    async health(ctx: ConnectorContext): Promise<HealthStatus> {
      try {
        await get('/wiki/rest/api/user/current', ctx)
        return { state: 'ok', checkedAt: ctx.now() }
      } catch (error) {
        if (error instanceof RateLimitedError) {
          return {
            state: 'degraded',
            checkedAt: ctx.now(),
            problem: 'Confluence is rate limiting this integration.',
            remedy: 'No action needed — syncing resumes automatically after the requested delay.',
          }
        }
        const status = (error as UpstreamError).details?.status
        if (status === 401) {
          return {
            state: 'failed',
            checkedAt: ctx.now(),
            problem: 'The Confluence access token was rejected and could not be refreshed.',
            remedy: 'Reconnect Atlassian for this workspace; if access was revoked, grant it again there first.',
          }
        }
        return {
          state: 'degraded',
          checkedAt: ctx.now(),
          problem: `Confluence did not answer a health check: ${(error as Error).message}`,
          remedy: 'No action needed yet — usually transient. Investigate if it persists.',
        }
      }
    },
  }
}
