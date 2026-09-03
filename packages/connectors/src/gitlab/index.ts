import { RateLimitedError, UpstreamError, type Signal } from '@chorus/core'
import { timingSafeEqual } from 'node:crypto'
import type {
  AuthSpec,
  Capabilities,
  Connector,
  ConnectorContext,
  HealthStatus,
  PullResult,
  WebhookRequest,
  WebhookSpec,
} from '../contract.js'
import { GITLAB_STREAMS, actor, at, scopeFor, str } from './streams.js'

/**
 * The GitLab connector (INT-2).
 *
 * Built second on purpose. GitLab differs from GitHub in three places that each
 * sit exactly where a framework shaped around one provider would have baked in
 * an assumption:
 *
 *  - **Pagination is by header** (`x-next-page`), not by short page. A sync that
 *    stopped on a short page would end early whenever GitLab returned fewer
 *    items than asked for, which it does.
 *  - **Webhooks carry a shared token, not a signature.** GitLab sends the secret
 *    itself in `x-gitlab-token`. The framework's `verify(request, secret)` is
 *    generic enough for that only because it was never named `verifySignature`.
 *  - **Access tokens expire and must be refreshed.** This is the first connector
 *    to use `ctx.saveCredentials`, and the first to exercise the refresh
 *    guarantee in the contract kit.
 */

export interface GitLabOptions {
  readonly fetch?: typeof fetch
  readonly apiBaseUrl?: string
  /** The OAuth application, from deployment configuration — never workspace data. */
  readonly clientId?: string
  readonly clientSecret?: string
}

const DEFAULT_API = 'https://gitlab.com/api/v4'
const DEFAULT_OAUTH = 'https://gitlab.com/oauth/token'
const PAGE_SIZE = 30

interface Cursor {
  readonly r: number
  readonly s: number
  readonly p: number
}

const START: Cursor = { r: 0, s: 0, p: 1 }

function parseCursor(raw: string | null): Cursor {
  if (!raw) return START
  try {
    const parsed = JSON.parse(raw) as Partial<Cursor>
    if (
      typeof parsed.r === 'number' &&
      typeof parsed.s === 'number' &&
      typeof parsed.p === 'number'
    ) {
      return { r: parsed.r, s: parsed.s, p: parsed.p }
    }
  } catch {
    // Unreadable: start over. Ingestion is idempotent, so that is safe, whereas
    // guessing a position skips data silently.
  }
  return START
}

function projectsOf(ctx: ConnectorContext): string[] {
  const configured = ctx.config.projects
  return Array.isArray(configured) ? configured.filter((p): p is string => typeof p === 'string') : []
}

/** Unknown visibility means private, for the same reason it does on GitHub. */
function isPrivate(ctx: ConnectorContext, project: string): boolean {
  const declared = ctx.config.privateProjects
  if (Array.isArray(declared)) return declared.includes(project)
  return true
}

export const gitlabWebhooks: WebhookSpec = {
  secretKey: 'webhookToken',
  // GitLab offers no HMAC. Declared honestly rather than described as a
  // signature it is not.
  verification: 'shared_secret',

  deliveryId(request: WebhookRequest) {
    return request.headers['x-gitlab-event-uuid'] ?? null
  },

  /**
   * GitLab sends the shared secret itself rather than a signature over the
   * body. Weaker than an HMAC — it proves possession of the secret but not that
   * the body is untampered — and it is what GitLab offers, so it is compared in
   * constant time and nothing more is claimed for it.
   */
  verify(request: WebhookRequest, secret: string) {
    const presented = request.headers['x-gitlab-token'] ?? ''
    const a = Buffer.from(presented, 'utf8')
    const b = Buffer.from(secret, 'utf8')
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
  },
}

async function raiseFor(response: Response, ctx: ConnectorContext): Promise<never> {
  const body = await response.text().catch(() => '')
  const retryAfter = response.headers.get('retry-after')
  const remaining = response.headers.get('ratelimit-remaining')
  const reset = response.headers.get('ratelimit-reset')

  if (response.status === 429 || (retryAfter && remaining === '0')) {
    const retryAfterMs = retryAfter
      ? Number(retryAfter) * 1000
      : Math.max(1000, Number(reset) * 1000 - ctx.now().getTime())
    throw new RateLimitedError('GitLab applied a rate limit', {
      retryAfterMs,
      status: response.status,
    })
  }

  throw new UpstreamError(`GitLab responded ${response.status}`, {
    status: response.status,
    body: body.slice(0, 500),
  })
}

export function createGitLabConnector(options: GitLabOptions = {}): Connector {
  const api = options.apiBaseUrl ?? DEFAULT_API

  const auth: AuthSpec = {
    kind: 'oauth2',
    authorizationUrl: 'https://gitlab.com/oauth/authorize',
    tokenUrl: DEFAULT_OAUTH,
    scopes: ['read_api', 'read_repository'],
  }

  const capabilities: Capabilities = { source: true, repos: true }

  /**
   * Exchanges the refresh token for a new pair, and stores it.
   *
   * GitLab rotates the refresh token on every use, so the *new* one has to be
   * persisted or the next refresh fails and the integration silently dies an
   * hour later. That is the failure this exists to avoid, and it is why
   * `saveCredentials` is awaited rather than fired and forgotten.
   */
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

    const granted = (await response.json()) as {
      access_token?: string
      refresh_token?: string
    }
    if (!granted.access_token) return undefined

    await ctx.saveCredentials({
      ...ctx.credentials,
      accessToken: granted.access_token,
      // Rotated by GitLab on every use; keeping the old one would work exactly
      // once more and then stop.
      ...(granted.refresh_token ? { refreshToken: granted.refresh_token } : {}),
    })
    return granted.access_token
  }

  async function call(path: string, ctx: ConnectorContext): Promise<Response> {
    const http = options.fetch ?? ctx.fetch
    const send = (token: string) =>
      http(`${api}${path}`, {
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      })

    const first = await send(ctx.credentials.accessToken ?? '')
    if (first.status !== 401) return first

    // One refresh, one retry. A loop here would hammer the token endpoint when
    // the refresh token itself is dead, which is the case where a human has to
    // reconnect anyway.
    const refreshed = await refresh(ctx)
    return refreshed ? send(refreshed) : first
  }

  return {
    kind: 'gitlab',
    auth,
    capabilities,
    webhooks: gitlabWebhooks,

    async pull(cursor: string | null, ctx: ConnectorContext): Promise<PullResult> {
      const projects = projectsOf(ctx)
      if (projects.length === 0) return { signals: [], nextCursor: null }

      const position = parseCursor(cursor)
      const project = projects[position.r]
      const stream = GITLAB_STREAMS[position.s]
      if (!project || !stream) return { signals: [], nextCursor: null }

      const query = new URLSearchParams({
        ...(stream.query ?? {}),
        per_page: String(PAGE_SIZE),
        page: String(position.p),
      })
      const response = await call(
        `/projects/${encodeURIComponent(project)}${stream.path}?${query}`,
        ctx,
      )
      if (!response.ok) await raiseFor(response, ctx)

      const items = stream.itemsOf(await response.json())
      const signals = items.map((item) => stream.toSignal(item, project, isPrivate(ctx, project)))

      // GitLab states the next page in a header, and it is authoritative. A
      // short page is *not* a reliable end signal here: GitLab returns fewer
      // items than asked for in several documented cases, and stopping on that
      // would end a sync early and silently.
      const nextPage = response.headers.get('x-next-page')
      const hasMore = nextPage !== null && nextPage !== ''

      const next: Cursor = hasMore
        ? { ...position, p: Number(nextPage) }
        : {
            r: position.s + 1 >= GITLAB_STREAMS.length ? position.r + 1 : position.r,
            s: position.s + 1 >= GITLAB_STREAMS.length ? 0 : position.s + 1,
            p: 1,
          }

      const finished = !hasMore && next.r >= projects.length
      return { signals, nextCursor: finished ? null : JSON.stringify(next) }
    },

    async handleWebhook(
      request: WebhookRequest,
      ctx: ConnectorContext,
    ): Promise<readonly Signal[]> {
      const payload = JSON.parse(request.body) as Record<string, unknown>
      const project = projectOf(payload)
      const restricted = isPrivate(ctx, project)

      switch (payload.object_kind) {
        case 'issue':
          return [
            streamNamed('issue').toSignal(
              attributesOf(payload),
              project,
              restricted,
            ),
          ]
        case 'merge_request':
          return [streamNamed('merge_request').toSignal(attributesOf(payload), project, restricted)]
        case 'note':
          return [streamNamed('issue_comment').toSignal(attributesOf(payload), project, restricted)]
        case 'pipeline':
          return [
            streamNamed('pipeline').toSignal(
              (payload.object_attributes ?? {}) as Record<string, unknown>,
              project,
              restricted,
            ),
          ]
        case 'deployment':
          return [streamNamed('deployment').toSignal(payload, project, restricted)]
        case 'push':
          return pushSignals(payload, project, restricted)
        default:
          // An event we do not map is not an error: GitLab delivers whatever the
          // hook subscribed to.
          return []
      }
    },

    async health(ctx: ConnectorContext): Promise<HealthStatus> {
      const response = await call('/user', ctx)

      if (response.status === 401) {
        return {
          state: 'failed',
          checkedAt: ctx.now(),
          problem: 'The GitLab access token was rejected and could not be refreshed.',
          remedy:
            'Reconnect GitLab for this workspace. If the authorisation was revoked in GitLab, it must be granted again there first.',
        }
      }
      if (response.status === 403) {
        return {
          state: 'failed',
          checkedAt: ctx.now(),
          problem: 'The GitLab token no longer has the scopes this integration needs.',
          remedy: 'Reconnect GitLab, granting the read_api and read_repository scopes.',
        }
      }
      if (!response.ok) {
        return {
          state: 'degraded',
          checkedAt: ctx.now(),
          problem: `GitLab responded ${response.status} to a health check.`,
          remedy: 'No action needed yet — this is usually transient. Investigate if it persists.',
        }
      }
      return { state: 'ok', checkedAt: ctx.now() }
    },
  }
}

const streamNamed = (name: string) => GITLAB_STREAMS.find((stream) => stream.name === name)!

const attributesOf = (payload: Record<string, unknown>): Record<string, unknown> => ({
  ...((payload.object_attributes ?? {}) as Record<string, unknown>),
  // Webhook payloads carry the actor at the top level, not on the object.
  author: payload.user,
})

function projectOf(payload: Record<string, unknown>): string {
  const project = payload.project as { path_with_namespace?: unknown } | undefined
  return typeof project?.path_with_namespace === 'string'
    ? project.path_with_namespace
    : 'unknown/unknown'
}

/**
 * Push commits, with the paths they changed.
 *
 * External ids match what the `/repository/commits` stream produces, so a push
 * and a later sync deduplicate against each other rather than storing the same
 * commit twice under two names.
 */
function pushSignals(
  payload: Record<string, unknown>,
  project: string,
  restricted: boolean,
): readonly Signal[] {
  const commits = Array.isArray(payload.commits)
    ? (payload.commits as Record<string, unknown>[])
    : []

  return commits.map((commit) => {
    const author = (commit.author ?? {}) as Record<string, unknown>
    const changedPaths = [
      ...(Array.isArray(commit.added) ? (commit.added as string[]) : []),
      ...(Array.isArray(commit.modified) ? (commit.modified as string[]) : []),
      ...(Array.isArray(commit.removed) ? (commit.removed as string[]) : []),
    ]

    return {
      source: 'gitlab',
      externalId: `${project}@${String(commit.id)}`,
      kind: 'commit',
      text: str(commit.message),
      structured: { project, sha: commit.id, ref: payload.ref ?? null, changedPaths },
      author:
        typeof author.email === 'string'
          ? { externalId: author.email, display: String(author.name ?? author.email) }
          : actor(commit),
      occurredAt: at(commit, 'timestamp'),
      url: str(commit.url),
      permissions: scopeFor(project, restricted),
      raw: commit,
    }
  })
}
