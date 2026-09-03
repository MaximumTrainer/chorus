import { RateLimitedError, UpstreamError, type Signal } from '@chorus/core'
import type {
  AuthSpec,
  Capabilities,
  Connector,
  ConnectorContext,
  HealthStatus,
  PullResult,
  WebhookRequest,
} from '../contract.js'
import { githubWebhooks, signalFromEvent } from './webhooks.js'
import { STREAMS } from './streams.js'

/**
 * The GitHub connector (INT-2).
 *
 * The git connector is the one dependency almost everything else has —
 * indexing, code pointers, briefs, pull requests, preview discovery — so its
 * job here is narrow and boring on purpose: turn GitHub's API into signals in
 * the envelope, and mint repository-scoped tokens for sandboxes.
 *
 * **Authentication is a GitHub App installation**, never a personal access
 * token. A PAT carries the reach of whoever created it, which is the whole
 * account; an installation token carries only what the installation was granted
 * and expires within the hour. That distinction is what makes AC2 a security
 * control rather than a convenience.
 */

export interface GitHubOptions {
  /** Injected so the contract suite can drive this from a cassette. */
  readonly fetch?: typeof fetch
  readonly apiBaseUrl?: string
  /** The app's own identity, from deployment configuration — never workspace data. */
  readonly appId?: string
  /**
   * Mints an app JWT. Injected rather than built here so the private key stays
   * in the process that holds it, and so tests need no key at all.
   */
  readonly appJwt?: () => Promise<string>
}

/** A token minted for one repository, for one job. Never stored (AC2). */
export interface ScopedRepositoryToken {
  readonly token: string
  readonly expiresAt: Date
  readonly repository: string
  readonly permissions: Readonly<Record<string, string>>
}

export interface GitHubConnector extends Connector {
  /**
   * A token scoped to one repository, for a coding sandbox (INT-2 AC2).
   *
   * Returned to the caller and never persisted: a stored short-lived token is a
   * long-lived one with extra steps.
   */
  mintRepositoryToken(
    repository: string,
    ctx: ConnectorContext,
    options?: { readonly permissions?: Readonly<Record<string, string>> },
  ): Promise<ScopedRepositoryToken>
}

const DEFAULT_API = 'https://api.github.com'
const PAGE_SIZE = 30

interface Cursor {
  /** Index into the configured repositories. */
  readonly r: number
  /** Index into STREAMS. */
  readonly s: number
  /** 1-based page within the current stream. */
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
    // A cursor we cannot read is one we must not guess at: starting over is
    // safe because ingestion is idempotent, whereas guessing a position skips
    // data silently.
  }
  return START
}

function repositoriesOf(ctx: ConnectorContext): string[] {
  const configured = ctx.config.repositories
  return Array.isArray(configured) ? configured.filter((r): r is string => typeof r === 'string') : []
}

/**
 * Turns a GitHub response into an error the framework can act on.
 *
 * The distinction that matters is rate limit versus everything else: the runner
 * resumes after the first and gives up on the second, so conflating them either
 * abandons a sync it should have resumed or hammers a source it should have
 * left alone.
 */
async function raiseFor(response: Response, ctx: ConnectorContext): Promise<never> {
  const body = await response.text().catch(() => '')

  // GitHub signals a rate limit as 403 or 429 with a zero remaining count, and
  // says when it resets. Honouring its own numbers beats guessing a backoff.
  const remaining = response.headers.get('x-ratelimit-remaining')
  const reset = response.headers.get('x-ratelimit-reset')
  const retryAfter = response.headers.get('retry-after')

  if ((response.status === 403 || response.status === 429) && (remaining === '0' || retryAfter)) {
    const retryAfterMs = retryAfter
      ? Number(retryAfter) * 1000
      : Math.max(1000, Number(reset) * 1000 - ctx.now().getTime())
    throw new RateLimitedError('GitHub applied a rate limit', {
      retryAfterMs,
      status: response.status,
    })
  }

  throw new UpstreamError(`GitHub responded ${response.status}`, {
    status: response.status,
    // Truncated: a response body can be large, and this ends up in a health row
    // an admin reads.
    body: body.slice(0, 500),
  })
}

export function createGitHubConnector(options: GitHubOptions = {}): GitHubConnector {
  const api = options.apiBaseUrl ?? DEFAULT_API

  const auth: AuthSpec = {
    kind: 'github_app',
    appId: options.appId ?? 'unset',
    // Least privilege, and the list is short on purpose: this connector reads
    // and mints clone tokens. Writing pull requests is INT-4's job, with its
    // own grant.
    scopes: ['contents:read', 'issues:read', 'pull_requests:read', 'actions:read', 'deployments:read'],
  }

  const capabilities: Capabilities = { source: true, repos: true }

  async function call(
    path: string,
    ctx: ConnectorContext,
    init: RequestInit = {},
  ): Promise<Response> {
    const http = options.fetch ?? ctx.fetch
    const response = await http(`${api}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        authorization: `Bearer ${ctx.credentials.installationToken ?? ''}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    })
    return response
  }

  return {
    kind: 'github',
    auth,
    capabilities,
    webhooks: githubWebhooks,

    async pull(cursor: string | null, ctx: ConnectorContext): Promise<PullResult> {
      const repositories = repositoriesOf(ctx)
      if (repositories.length === 0) return { signals: [], nextCursor: null }

      const position = parseCursor(cursor)
      const repository = repositories[position.r]
      const stream = STREAMS[position.s]

      // Past the end of both lists: caught up. Reached when a cursor outlives a
      // repository being unlinked, so it is a normal state, not an error.
      if (!repository || !stream) return { signals: [], nextCursor: null }

      // Built rather than concatenated, so a stream's own parameters and the
      // pagination cannot collide into one malformed query.
      const query = new URLSearchParams({
        ...(stream.query ?? {}),
        per_page: String(PAGE_SIZE),
        page: String(position.p),
      })
      const response = await call(`/repos/${repository}${stream.path}?${query}`, ctx)
      if (!response.ok) await raiseFor(response, ctx)

      const payload = (await response.json()) as unknown
      const items = stream.itemsOf(payload)
      const signals = items.map((item) => stream.toSignal(item, repository, isPrivate(ctx, repository)))

      // A short page means the stream is exhausted. GitHub's `Link` header is
      // the stated way to paginate, but a short page is true for every endpoint
      // here and needs no header parsing — and a wrong `Link` parse silently
      // stops a sync early.
      const exhausted = items.length < PAGE_SIZE
      const next: Cursor = exhausted
        ? { r: position.s + 1 >= STREAMS.length ? position.r + 1 : position.r,
            s: position.s + 1 >= STREAMS.length ? 0 : position.s + 1,
            p: 1 }
        : { ...position, p: position.p + 1 }

      const finished = exhausted && next.r >= repositories.length
      return { signals, nextCursor: finished ? null : JSON.stringify(next) }
    },

    async handleWebhook(
      request: WebhookRequest,
      ctx: ConnectorContext,
    ): Promise<readonly Signal[]> {
      const event = request.headers['x-github-event'] ?? ''
      const payload = JSON.parse(request.body) as Record<string, unknown>
      return signalFromEvent(event, payload, (repository) => isPrivate(ctx, repository))
    },

    async health(ctx: ConnectorContext): Promise<HealthStatus> {
      const response = await call('/installation/repositories?per_page=1', ctx)

      if (response.status === 401) {
        return {
          state: 'failed',
          checkedAt: ctx.now(),
          problem: 'The GitHub installation token was rejected.',
          remedy:
            'Reconnect the GitHub App for this workspace. If the app was uninstalled, reinstall it and grant access to the repositories you want indexed.',
        }
      }
      if (response.status === 403 || response.status === 404) {
        return {
          state: 'failed',
          checkedAt: ctx.now(),
          problem: 'The GitHub App installation is no longer accessible.',
          remedy:
            'Check the app is still installed on the organisation and that it still has access to the selected repositories.',
        }
      }
      if (!response.ok) {
        return {
          state: 'degraded',
          checkedAt: ctx.now(),
          problem: `GitHub responded ${response.status} to a health check.`,
          remedy: 'No action needed yet — this is usually transient. Investigate if it persists.',
        }
      }
      return { state: 'ok', checkedAt: ctx.now() }
    },

    async mintRepositoryToken(repository, ctx, mintOptions = {}) {
      const installationId = String(ctx.config.installationId ?? '')
      if (!installationId) {
        throw new UpstreamError('This integration records no GitHub installation id', {
          integrationId: ctx.integrationId,
        })
      }
      if (!repositoriesOf(ctx).includes(repository)) {
        // The caller does not get to widen the grant by asking nicely: only
        // repositories this integration was linked to may be minted for.
        throw new UpstreamError('That repository is not linked to this integration', {
          repository,
        })
      }

      const jwt = options.appJwt ? await options.appJwt() : ctx.credentials.appJwt
      const http = options.fetch ?? ctx.fetch
      const response = await http(`${api}/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          authorization: `Bearer ${jwt ?? ''}`,
          'content-type': 'application/json',
        },
        // Named repository, named permissions. GitHub scopes the minted token
        // to exactly this, so a leaked sandbox token reaches one repository
        // read-only rather than the installation's whole reach.
        body: JSON.stringify({
          repositories: [repository.split('/').pop()],
          permissions: mintOptions.permissions ?? { contents: 'read', metadata: 'read' },
        }),
      })

      if (!response.ok) await raiseFor(response, ctx)

      const minted = (await response.json()) as {
        token: string
        expires_at: string
        permissions?: Record<string, string>
      }

      return {
        token: minted.token,
        expiresAt: new Date(minted.expires_at),
        repository,
        permissions: minted.permissions ?? {},
      }
    },
  }
}

/**
 * Whether a repository is private, from the integration's own config.
 *
 * Read from config rather than from each payload because the payload is not
 * always present — a commit list carries no repository object — and a signal
 * that defaulted to public would be surfaced to people who cannot see the
 * repository (AC7).
 */
function isPrivate(ctx: ConnectorContext, repository: string): boolean {
  const declared = ctx.config.privateRepositories
  if (Array.isArray(declared)) return declared.includes(repository)
  // Absent means unknown, and unknown must mean restricted: over-restricting
  // hides data from someone who could have seen it, under-restricting shows it
  // to someone who could not.
  return true
}
