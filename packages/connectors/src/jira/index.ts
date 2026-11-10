import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  RateLimitedError,
  UpstreamError,
  type EdgeCandidate,
  type EntityCandidate,
  type Signal,
} from '@chorus/core'
import type {
  AuthSpec,
  Capabilities,
  Connector,
  ConnectorContext,
  ExternalRef,
  HealthStatus,
  PullResult,
  SinkSpec,
  WebhookRequest,
  WebhookSpec,
} from '../contract.js'
import { candidatesFor, commentsFrom, edgesFor, issueToSignal, type JiraComment, type JiraIssue } from './streams.js'
import { adfToMarkdown, markdownToAdf, type AdfNode } from './adf.js'
import { requireMapping, requireTransition, type JiraTransition, type StatusMap } from './status-map.js'
import { detectHierarchyScheme, hierarchyFields, type HierarchyConfig } from './hierarchy.js'
import { createAtlassianClient, ATLASSIAN_OAUTH } from '../atlassian/client.js'

/** The input `create_issue` accepts. */
export interface JiraCreateIssueInput {
  readonly projectKey?: string
  readonly issueType: string
  readonly summary: string
  readonly description?: string
  readonly taskId?: string
  /** The key of the parent issue to link this one under, if any (AC4). */
  readonly parentKey?: string
  /** True when the parent is an epic, selecting the epic-link path on a
   * company-managed project; a subtask leaves this false. */
  readonly parentIsEpic?: boolean
}

/** The input `update_issue` accepts. */
export interface JiraUpdateIssueInput {
  readonly issueKey: string
  readonly summary?: string
  readonly description?: string
}

/** The input `comment` accepts. */
export interface JiraCommentInput {
  readonly issueKey: string
  /** The comment body, in Markdown. */
  readonly body: string
}

/** The input `transition` accepts: the Chorus status to move the issue to. */
export interface JiraTransitionInput {
  readonly issueKey: string
  readonly status: string
}

/**
 * The Jira issue property Chorus stamps for round-trip identity (AC6). It
 * carries the idempotency key a create searched by, so a re-sync — or a retry
 * whose first response was lost — finds the issue Chorus already made rather
 * than making a second.
 */
const CHORUS_PROPERTY = 'chorus'

/**
 * Jira Cloud's webhook authentication (INT-8 AC2).
 *
 * A dynamically-registered Jira webhook signs the raw body with HMAC-SHA256 in
 * `X-Hub-Signature` as `sha256=<hex>`, so this is a real signature scheme: the
 * body is authenticated, not merely the sender. Jira sends no stable per-event
 * delivery id, so one is derived from the event, the issue key and the event
 * timestamp — the triple that varies per event and survives a redelivery, which
 * is exactly what deduplication needs.
 */
export const jiraWebhooks: WebhookSpec = {
  secretKey: 'webhookSecret',
  verification: 'signature',

  deliveryId(request: WebhookRequest): string | null {
    try {
      const payload = JSON.parse(request.body) as {
        webhookEvent?: unknown
        timestamp?: unknown
        issue?: { key?: unknown }
      }
      const key = payload.issue?.key
      if (typeof key !== 'string') return null
      return `${String(payload.webhookEvent)}:${key}:${String(payload.timestamp)}`
    } catch {
      // An unparseable body cannot be deduplicated, so the framework refuses it
      // rather than accepting an event that might arrive again.
      return null
    }
  },

  verify(request: WebhookRequest, secret: string): boolean {
    const presented = request.headers['x-hub-signature'] ?? ''
    const expected = `sha256=${createHmac('sha256', secret).update(request.body).digest('hex')}`
    const a = Buffer.from(presented, 'utf8')
    const b = Buffer.from(expected, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  },
}

/**
 * Pull a human reason out of a Jira error body. Jira reports a rejected write as
 * `{ errorMessages: [...], errors: { field: msg } }`; either may be populated.
 * Falls back to the raw text so the message is never empty.
 */
function jiraReason(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      errorMessages?: unknown
      errors?: Record<string, unknown>
    }
    const messages = Array.isArray(parsed.errorMessages)
      ? parsed.errorMessages.map(String)
      : []
    const fields = parsed.errors ? Object.values(parsed.errors).map(String) : []
    const joined = [...messages, ...fields].filter(Boolean).join('; ')
    if (joined) return joined
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return raw.slice(0, 200) || 'no body'
}

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

const PAGE_SIZE = 50
const FIELDS = 'summary,description,status,issuetype,assignee,reporter,project,updated,parent,issuelinks,comment,components,fixVersions'

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

/**
 * The Jira connector, with its one Jira-specific capability beyond the common
 * `Connector` contract: detecting a project's hierarchy scheme at connect time
 * (AC4). It is a method rather than a contract addition because no other
 * connector has Jira's company-managed / team-managed split.
 */
export interface JiraConnector extends Connector {
  detectHierarchy(projectKey: string, ctx: ConnectorContext): Promise<HierarchyConfig>
}

export function createJiraConnector(options: JiraOptions = {}): JiraConnector {
  const api = (options.apiUrl ?? 'https://api.atlassian.com/ex/jira/cloud').replace(/\/$/, '')

  const auth: AuthSpec = {
    kind: 'oauth2',
    authorizationUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: ATLASSIAN_OAUTH,
    scopes: ['read:jira-work', 'read:jira-user', 'offline_access'],
  }
  const capabilities: Capabilities = { source: true, sink: true }

  // The Bearer auth, rotating-refresh and error handling are identical across
  // Atlassian products, so they come from the shared client; only the reason
  // extractor is Jira's.
  const client = createAtlassianClient({
    apiUrl: api,
    product: 'Jira',
    reason: jiraReason,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.clientId ? { clientId: options.clientId } : {}),
    ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
  })
  const request = client.request
  const get = client.get

  const siteUrl = (ctx: ConnectorContext): string =>
    typeof ctx.config.siteUrl === 'string' ? ctx.config.siteUrl : 'https://example.atlassian.net'
  const restricted = (ctx: ConnectorContext): boolean => ctx.config.privateByDefault !== false
  const jqlFor = (ctx: ConnectorContext): string =>
    typeof ctx.config.jql === 'string' ? ctx.config.jql : 'order by updated asc'
  const browseUrl = (key: string, ctx: ConnectorContext): string =>
    `${siteUrl(ctx).replace(/\/$/, '')}/browse/${key}`
  /** The hierarchy scheme stored on the integration, or the classic default. */
  const hierarchyFor = (ctx: ConnectorContext): HierarchyConfig => {
    const stored = ctx.config.hierarchy as HierarchyConfig | undefined
    return stored?.scheme ? stored : { scheme: 'epic_link' }
  }

  /**
   * Find an issue a previous create stamped with this idempotency key, through
   * the `chorus` property (AC2/AC6). JQL can query an issue property, so the
   * search is precise and needs no local mapping — which is the point: it still
   * finds the issue after `external_links` is gone.
   */
  async function findByProperty(
    key: string,
    ctx: ConnectorContext,
  ): Promise<ExternalRef | null> {
    const jql = `issue.property[${CHORUS_PROPERTY}].idempotencyKey = "${key}"`
    const data = await get(
      `/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=1&fields=summary`,
      ctx,
    )
    const issues = Array.isArray(data.issues) ? (data.issues as Array<{ key?: string }>) : []
    const found = issues[0]
    if (!found?.key) return null
    return { externalId: found.key, url: browseUrl(found.key, ctx) }
  }

  /** Stamp the `chorus` identity property so a later sync recognises this issue. */
  async function writeIdentity(
    issueKey: string,
    key: string,
    taskId: string | undefined,
    ctx: ConnectorContext,
  ): Promise<void> {
    await request(
      'PUT',
      `/rest/api/3/issue/${issueKey}/properties/${CHORUS_PROPERTY}`,
      { idempotencyKey: key, ...(taskId ? { taskId } : {}) },
      ctx,
    )
  }

  const sink: SinkSpec = {
    actions: {
      create_issue: {
        name: 'create_issue',
        sideEffect: 'external',
        find: (key, ctx) => findByProperty(key, ctx),
        async execute(input, key, ctx): Promise<ExternalRef> {
          const { projectKey, issueType, summary, description, taskId, parentKey, parentIsEpic } =
            input as JiraCreateIssueInput
          const project = projectKey ?? (ctx.config.projectKey as string | undefined)
          // The parent linkage obeys the scheme detected for the project at
          // connect time and stored on the integration (AC4); no parent means
          // no linkage fields.
          const parentFields = parentKey
            ? hierarchyFields(hierarchyFor(ctx), parentKey, parentIsEpic === true)
            : {}
          const response = await request(
            'POST',
            '/rest/api/3/issue',
            {
              fields: {
                ...(project ? { project: { key: project } } : {}),
                issuetype: { name: issueType },
                summary,
                ...(description !== undefined
                  ? { description: markdownToAdf(description) }
                  : {}),
                ...parentFields,
              },
            },
            ctx,
          )
          const created = (await response.json()) as { key?: string }
          if (!created.key) {
            throw new UpstreamError('Jira issue create returned no key', { payload: created })
          }
          // The property write is a second request: an issue created without its
          // identity stamp would be made twice on the next sync, which is the
          // exact duplication AC6 forbids.
          await writeIdentity(created.key, key, taskId, ctx)
          return { externalId: created.key, url: browseUrl(created.key, ctx) }
        },
      },

      update_issue: {
        name: 'update_issue',
        sideEffect: 'external',
        // An update sets the same fields to the same values on retry, so it is
        // naturally idempotent and needs no search-before-write.
        async execute(input, _key, ctx): Promise<ExternalRef> {
          const { issueKey, summary, description } = input as JiraUpdateIssueInput
          await request(
            'PUT',
            `/rest/api/3/issue/${issueKey}`,
            {
              fields: {
                ...(summary !== undefined ? { summary } : {}),
                ...(description !== undefined
                  ? { description: markdownToAdf(description) }
                  : {}),
              },
            },
            ctx,
          )
          return { externalId: issueKey, url: browseUrl(issueKey, ctx) }
        },
      },

      transition: {
        name: 'transition',
        sideEffect: 'external',
        // Mirroring a status is setting one field to a target state, so the
        // write is naturally idempotent and needs no search-before-write. The
        // mapping, not the write, is where AC5 lives: an unmapped Chorus status
        // is blocked here — before any call to Jira — rather than guessed.
        async execute(input, _key, ctx): Promise<ExternalRef> {
          const { issueKey, status } = input as JiraTransitionInput
          const map = (ctx.config.statusMap ?? {}) as StatusMap
          const jiraStatus = requireMapping(status, map)
          const data = await get(`/rest/api/3/issue/${issueKey}/transitions`, ctx)
          const available = Array.isArray(data.transitions)
            ? (data.transitions as JiraTransition[])
            : []
          const transition = requireTransition(jiraStatus, available)
          await request(
            'POST',
            `/rest/api/3/issue/${issueKey}/transitions`,
            { transition: { id: transition.id } },
            ctx,
          )
          return { externalId: issueKey, url: browseUrl(issueKey, ctx) }
        },
      },

      comment: {
        name: 'comment',
        sideEffect: 'external',
        // A comment is a create, so a lost-response retry would double-post. The
        // action has the issue key, so it searches that issue's own comments for
        // its idempotency marker before posting — the marker rides on its own
        // line so it reads as metadata rather than prose.
        async execute(input, key, ctx): Promise<ExternalRef> {
          const { issueKey, body } = input as JiraCommentInput
          const marker = `[chorus-idem:${key}]`
          const data = await get(`/rest/api/3/issue/${issueKey}/comment`, ctx)
          const comments = Array.isArray(data.comments)
            ? (data.comments as Array<{ id?: string; body?: AdfNode }>)
            : []
          const already = comments.find((c) => c.body && adfToMarkdown(c.body).includes(marker))
          if (already?.id) {
            return { externalId: already.id, url: `${browseUrl(issueKey, ctx)}?focusedCommentId=${already.id}` }
          }
          const created = (await request(
            'POST',
            `/rest/api/3/issue/${issueKey}/comment`,
            { body: markdownToAdf(`${body}\n\n${marker}`) },
            ctx,
          ).then((r) => r.json())) as { id?: string }
          if (!created.id) {
            throw new UpstreamError('Jira comment create returned no id', { payload: created })
          }
          return { externalId: created.id, url: `${browseUrl(issueKey, ctx)}?focusedCommentId=${created.id}` }
        },
      },
    },
  }

  return {
    kind: 'jira',
    auth,
    capabilities,
    sink,

    async pull(cursor: string | null, ctx: ConnectorContext): Promise<PullResult> {
      const { startAt } = parseCursor(cursor)
      const jql = encodeURIComponent(jqlFor(ctx))
      const data = await get(
        `/rest/api/3/search?jql=${jql}&startAt=${startAt}&maxResults=${PAGE_SIZE}&fields=${FIELDS}`,
        ctx,
      )
      const issues = Array.isArray(data.issues) ? (data.issues as JiraIssue[]) : []
      const total = typeof data.total === 'number' ? data.total : startAt + issues.length

      // An issue and its comments ride the same page: the issue as one signal,
      // each comment as its own, so the brain sees the discussion as evidence.
      const signals = issues.flatMap((issue) => [
        issueToSignal(issue, siteUrl(ctx), restricted(ctx)),
        ...commentsFrom(issue, siteUrl(ctx), restricted(ctx)),
      ])

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

    mapEdges(signal: Signal): readonly EdgeCandidate[] {
      return edgesFor(signal)
    },

    webhooks: jiraWebhooks,

    // A webhook carries the whole issue, so the same `issueToSignal` the pull
    // uses produces the same `jira:issue:<key>` identity — which is what lets a
    // change seen by both the live webhook and the catch-up JQL sync dedupe to
    // one (AC2). Only issue create/update events become signals; anything else
    // (worklogs, deletions, a body without an issue) has nothing to ingest here.
    async handleWebhook(request: WebhookRequest, ctx: ConnectorContext): Promise<readonly Signal[]> {
      let payload: { webhookEvent?: unknown; issue?: unknown; comment?: unknown }
      try {
        payload = JSON.parse(request.body) as { webhookEvent?: unknown; issue?: unknown; comment?: unknown }
      } catch {
        return []
      }
      const event = typeof payload.webhookEvent === 'string' ? payload.webhookEvent : ''

      // A comment event carries both the comment and its issue; the comment is
      // wrapped into the issue so the same `commentsFrom` the pull uses produces
      // the same `jira:comment:<id>` identity, and the two paths dedupe (AC2).
      if (/^comment_(created|updated)$/.test(event) && payload.comment && payload.issue) {
        const issue = payload.issue as JiraIssue
        const withComment: JiraIssue = {
          ...issue,
          fields: { ...(issue.fields ?? {}), comment: { comments: [payload.comment as JiraComment] } },
        }
        return commentsFrom(withComment, siteUrl(ctx), restricted(ctx))
      }

      if (!payload.issue || !/^jira:issue_(created|updated)$/.test(event)) return []
      return [issueToSignal(payload.issue as JiraIssue, siteUrl(ctx), restricted(ctx))]
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

    // Detected at connect time and stored on the integration (AC4): the connect
    // flow calls this per project and persists the result as `config.hierarchy`,
    // which the sink then reads to link a task tree the right way.
    async detectHierarchy(projectKey: string, ctx: ConnectorContext): Promise<HierarchyConfig> {
      const project = await get(`/rest/api/3/project/${encodeURIComponent(projectKey)}`, ctx)
      // The field catalogue is a JSON array, not an object.
      const fields = (await request('GET', '/rest/api/3/field', undefined, ctx).then((r) => r.json())) as unknown
      const list = Array.isArray(fields) ? (fields as Array<{ id?: string; name?: string }>) : []
      return detectHierarchyScheme(typeof project.style === 'string' ? project.style : undefined, list)
    },
  }
}
