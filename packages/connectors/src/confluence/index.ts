import { RateLimitedError, UpstreamError, type EntityCandidate, type Signal } from '@chorus/core'
import type {
  AuthSpec,
  Capabilities,
  Connector,
  ConnectorContext,
  ExternalRef,
  HealthStatus,
  PullResult,
  SinkSpec,
} from '../contract.js'
import { createAtlassianClient, ATLASSIAN_OAUTH } from '../atlassian/client.js'
import { candidatesFor, pageToSignal, type ConfluencePage } from './streams.js'
import { markdownToConfluence } from './body.js'

/** The input the `publish` sink action accepts. */
export interface ConfluencePublishInput {
  readonly spaceKey: string
  readonly title: string
  /** The document body, in Markdown. */
  readonly body: string
  /** The Chorus document id, carried in the `chorus-doc-id` property for AC5. */
  readonly docId: string
  /** Optional parent page id to publish under. */
  readonly parentId?: string
  /** Optional Chorus document URL; when given, a header banner links back to it. */
  readonly chorusUrl?: string
}

/** The Confluence content property that carries a page's Chorus document identity. */
const DOC_PROPERTY = 'chorus-doc-id'

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
/** Group members per request — Confluence's own maximum for this endpoint. */
const GROUP_PAGE_SIZE = 200

/**
 * One person in a Confluence group (NFR-4 AC1). `email` is null when the user
 * has hidden it — never an empty string a matcher could mistake for a value.
 */
export interface ConfluenceGroupMember {
  readonly accountId: string
  readonly displayName: string
  readonly email: string | null
}

/** The Confluence connector, plus what the membership sync needs beyond the contract. */
export interface ConfluenceConnector extends Connector {
  /**
   * Everyone in a group, across every page. App accounts (automation, bots)
   * are left out: they are not people a restricted page could be shown to. A
   * group deleted upstream has nobody in it, so this answers an empty list and
   * the sync revokes the scope, rather than failing and leaving access in place.
   */
  groupMembers(groupName: string, ctx: ConnectorContext): Promise<readonly ConfluenceGroupMember[]>
}

interface RawGroupMember {
  accountId?: unknown
  accountType?: unknown
  displayName?: unknown
  email?: unknown
}
const EXPAND = 'space,version,history.createdBy,body.atlas_doc_format,restrictions.read.restrictions.user,restrictions.read.restrictions.group'

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

export function createConfluenceConnector(options: ConfluenceOptions = {}): ConfluenceConnector {
  const api = (options.apiUrl ?? 'https://api.atlassian.com/ex/confluence/cloud').replace(/\/$/, '')

  const auth: AuthSpec = {
    kind: 'oauth2',
    authorizationUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: ATLASSIAN_OAUTH,
    // Group membership is read so a page restricted to a group reaches exactly
    // that group (NFR-4 AC1).
    scopes: ['read:confluence-content.all', 'read:confluence-space.summary', 'read:confluence-groups', 'offline_access'],
  }
  const capabilities: Capabilities = { source: true, sink: true }

  const client = createAtlassianClient({
    apiUrl: api,
    product: 'Confluence',
    reason: confluenceReason,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.clientId ? { clientId: options.clientId } : {}),
    ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
  })
  const get = client.get
  const request = client.request

  const siteUrl = (ctx: ConnectorContext): string =>
    typeof ctx.config.siteUrl === 'string' ? ctx.config.siteUrl : 'https://example.atlassian.net'
  const restricted = (ctx: ConnectorContext): boolean => ctx.config.privateByDefault !== false
  const cqlFor = (ctx: ConnectorContext): string =>
    typeof ctx.config.cql === 'string' ? ctx.config.cql : 'type in (page, blogpost) order by lastmodified asc'
  const pageUrl = (page: { _links?: { webui?: string } }, ctx: ConnectorContext): string =>
    `${siteUrl(ctx).replace(/\/$/, '')}/wiki${page._links?.webui ?? ''}`

  /**
   * The page already published for this document, found through its
   * `chorus-doc-id` content property (AC5). This is what makes republishing
   * update in place even after the local mapping is lost — the identity lives
   * in Confluence, not only in our database.
   */
  async function findByDocId(
    docId: string,
    ctx: ConnectorContext,
  ): Promise<{ id: string; version: number; webui?: string } | null> {
    const cql = `type=page and content.property[${DOC_PROPERTY}].docId = "${docId}"`
    const data = await get(
      `/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=1&expand=version`,
      ctx,
    )
    const results = Array.isArray(data.results)
      ? (data.results as Array<{ id?: string; version?: { number?: number }; _links?: { webui?: string } }>)
      : []
    const found = results[0]
    if (!found?.id) return null
    return { id: found.id, version: found.version?.number ?? 1, ...(found._links?.webui ? { webui: found._links.webui } : {}) }
  }

  // A header banner linking back to the source document, so a reader of the
  // Confluence page knows it is published from Chorus and where to edit it.
  const withBanner = (markdown: string, chorusUrl: string | undefined): string =>
    chorusUrl
      ? `> [!INFO]\n> Published from Chorus — [view the source document](${chorusUrl})\n\n${markdown}`
      : markdown

  const bodyField = (markdown: string, chorusUrl?: string): Record<string, unknown> => ({
    atlas_doc_format: {
      value: JSON.stringify(markdownToConfluence(withBanner(markdown, chorusUrl))),
      representation: 'atlas_doc_format',
    },
  })

  const sink: SinkSpec = {
    actions: {
      publish: {
        name: 'publish',
        sideEffect: 'external',
        // Publish is an upsert, so idempotency is handled inside execute by the
        // doc-id property search — a republish, a lost-response retry, and a
        // recovery after the local mapping is gone all resolve the same page.
        async execute(input, _key, ctx): Promise<ExternalRef> {
          const { spaceKey, title, body, docId, parentId, chorusUrl } = input as ConfluencePublishInput
          const existing = await findByDocId(docId, ctx)

          if (existing) {
            const updated = (await request(
              'PUT',
              `/wiki/rest/api/content/${existing.id}`,
              {
                type: 'page',
                title,
                version: { number: existing.version + 1 },
                body: bodyField(body, chorusUrl),
              },
              ctx,
            ).then((r) => r.json())) as { id?: string; _links?: { webui?: string } }
            return {
              externalId: existing.id,
              url: pageUrl({ _links: updated._links ?? (existing.webui ? { webui: existing.webui } : {}) }, ctx),
            }
          }

          const created = (await request(
            'POST',
            '/wiki/rest/api/content',
            {
              type: 'page',
              title,
              space: { key: spaceKey },
              ...(parentId ? { ancestors: [{ id: parentId }] } : {}),
              body: bodyField(body, chorusUrl),
            },
            ctx,
          ).then((r) => r.json())) as { id?: string; _links?: { webui?: string } }
          if (!created.id) {
            throw new UpstreamError('Confluence page create returned no id', { payload: created })
          }
          // Stamp the identity so the next publish finds this page (AC5).
          await request(
            'PUT',
            `/wiki/rest/api/content/${created.id}/property/${DOC_PROPERTY}`,
            { key: DOC_PROPERTY, value: { docId } },
            ctx,
          )
          return { externalId: created.id, url: pageUrl(created, ctx) }
        },
      },
    },
  }

  return {
    kind: 'confluence',
    auth,
    capabilities,
    sink,

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

    async groupMembers(groupName: string, ctx: ConnectorContext): Promise<readonly ConfluenceGroupMember[]> {
      const members: ConfluenceGroupMember[] = []
      let start = 0
      for (;;) {
        let data: Record<string, unknown>
        try {
          data = await get(
            `/wiki/rest/api/group/member?name=${encodeURIComponent(groupName)}&start=${start}&limit=${GROUP_PAGE_SIZE}`,
            ctx,
          )
        } catch (error) {
          // A group that no longer exists has no members; anything else is a real failure.
          if (error instanceof UpstreamError && error.details?.status === 404) return members
          throw error
        }
        const results = Array.isArray(data.results) ? (data.results as RawGroupMember[]) : []
        for (const raw of results) {
          if (typeof raw.accountId !== 'string' || raw.accountId === '') continue
          if (raw.accountType === 'app') continue
          members.push({
            accountId: raw.accountId,
            displayName: typeof raw.displayName === 'string' ? raw.displayName : raw.accountId,
            email: typeof raw.email === 'string' && raw.email.trim() !== '' ? raw.email.trim() : null,
          })
        }
        const links = (data._links ?? {}) as { next?: unknown }
        if (typeof links.next !== 'string' || results.length === 0) return members
        start += results.length
      }
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
