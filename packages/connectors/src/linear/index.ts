import { createHmac, timingSafeEqual } from 'node:crypto'
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
  WebhookRequest,
  WebhookSpec,
} from '../contract.js'
import { LINEAR_STREAMS, candidatesFor, toSignal } from './streams.js'

/**
 * The Linear connector (INT-2 AC5).
 *
 * The third provider, and the one that differs most. Linear is **GraphQL**:
 * every request is a POST to one URL, so a request is identified by its query
 * rather than its path, and pagination is an opaque `after` cursor with a
 * `hasNextPage` flag rather than a page number or a `Link` header.
 *
 * That is the third distinct pagination model in three providers, which is the
 * argument for the framework owning only "a null cursor means caught up" and
 * leaving termination to the connector.
 *
 * Linear also sends no per-delivery identifier on its webhooks, so one is
 * derived from the payload — the case the framework's "refuse a delivery with
 * no identifier" rule would otherwise reject outright.
 */

export interface LinearOptions {
  readonly fetch?: typeof fetch
  readonly apiUrl?: string
  readonly clientId?: string
  readonly clientSecret?: string
}

const DEFAULT_API = 'https://api.linear.app/graphql'
const DEFAULT_OAUTH = 'https://api.linear.app/oauth/token'
const PAGE_SIZE = 30

interface Cursor {
  /** Index into LINEAR_STREAMS. */
  readonly s: number
  /** Linear's opaque cursor within the current stream. */
  readonly after: string | null
}

const START: Cursor = { s: 0, after: null }

function parseCursor(raw: string | null): Cursor {
  if (!raw) return START
  try {
    const parsed = JSON.parse(raw) as Partial<Cursor>
    if (typeof parsed.s === 'number') {
      return { s: parsed.s, after: typeof parsed.after === 'string' ? parsed.after : null }
    }
  } catch {
    // Unreadable: start over. Ingestion is idempotent.
  }
  return START
}

/**
 * Linear's webhook authentication.
 *
 * HMAC-SHA256 over the raw body in `linear-signature`, so this is a genuine
 * signature scheme — unlike GitLab's.
 */
export const linearWebhooks: WebhookSpec = {
  secretKey: 'webhookSecret',
  verification: 'signature',

  /**
   * Derived, because Linear sends no per-delivery id.
   *
   * `webhookId` identifies the *subscription*, not the delivery, so using it
   * would collapse every delivery into one and the second event would be
   * discarded as a duplicate. The triple below is what actually varies per
   * delivery, and it is stable across a redelivery of the same event — which is
   * exactly what deduplication needs.
   */
  deliveryId(request: WebhookRequest) {
    try {
      const payload = JSON.parse(request.body) as {
        type?: unknown
        action?: unknown
        webhookTimestamp?: unknown
        data?: { id?: unknown }
      }
      const id = payload.data?.id
      if (typeof id !== 'string') return null
      return `${String(payload.type)}:${String(payload.action)}:${id}:${String(
        payload.webhookTimestamp,
      )}`
    } catch {
      // An unparseable body cannot be deduplicated, so the framework refuses it
      // rather than accepting an event that might arrive again.
      return null
    }
  },

  verify(request: WebhookRequest, secret: string) {
    const presented = request.headers['linear-signature'] ?? ''
    const expected = createHmac('sha256', secret).update(request.body).digest('hex')
    const a = Buffer.from(presented, 'utf8')
    const b = Buffer.from(expected, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  },
}

/**
 * Takes no context, unlike GitHub's and GitLab's: Linear states a plain
 * `retry-after` and never a reset timestamp, so there is no clock to read.
 */
async function raiseFor(response: Response): Promise<never> {
  const body = await response.text().catch(() => '')
  const retryAfter = response.headers.get('retry-after')

  if (response.status === 429) {
    throw new RateLimitedError('Linear applied a rate limit', {
      retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : 60_000,
      status: response.status,
    })
  }

  throw new UpstreamError(`Linear responded ${response.status}`, {
    status: response.status,
    body: body.slice(0, 500),
  })
}

export function createLinearConnector(options: LinearOptions = {}): Connector {
  const api = options.apiUrl ?? DEFAULT_API

  const auth: AuthSpec = {
    kind: 'oauth2',
    authorizationUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: DEFAULT_OAUTH,
    scopes: ['read'],
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

    const granted = (await response.json()) as {
      access_token?: string
      refresh_token?: string
    }
    if (!granted.access_token) return undefined

    await ctx.saveCredentials({
      ...ctx.credentials,
      accessToken: granted.access_token,
      ...(granted.refresh_token ? { refreshToken: granted.refresh_token } : {}),
    })
    return granted.access_token
  }

  /** One GraphQL request, with a single refresh-and-retry on a 401. */
  async function query(
    document: string,
    variables: Record<string, unknown>,
    ctx: ConnectorContext,
  ): Promise<Record<string, unknown>> {
    const http = options.fetch ?? ctx.fetch
    const send = (token: string) =>
      http(api, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: token },
        body: JSON.stringify({ query: document, variables }),
      })

    let response = await send(ctx.credentials.accessToken ?? '')
    if (response.status === 401) {
      const refreshed = await refresh(ctx)
      if (refreshed) response = await send(refreshed)
    }
    if (!response.ok) await raiseFor(response)

    const body = (await response.json()) as {
      data?: Record<string, unknown>
      errors?: Array<{ message?: string; extensions?: { code?: string } }>
    }

    // GraphQL answers 200 with an `errors` array, so a connector that only
    // checks the status treats a failed query as an empty result — a sync that
    // silently ingests nothing and reports success.
    if (body.errors?.length) {
      const first = body.errors[0]!
      if (first.extensions?.code === 'RATELIMITED') {
        throw new RateLimitedError('Linear applied a rate limit', { retryAfterMs: 60_000 })
      }
      throw new UpstreamError(`Linear query failed: ${first.message ?? 'unknown error'}`, {
        errors: body.errors.slice(0, 3),
      })
    }

    return body.data ?? {}
  }

  const restricted = (ctx: ConnectorContext): boolean =>
    ctx.config.privateByDefault !== false

  return {
    kind: 'linear',
    auth,
    capabilities,
    webhooks: linearWebhooks,

    async pull(cursor: string | null, ctx: ConnectorContext): Promise<PullResult> {
      const position = parseCursor(cursor)
      const stream = LINEAR_STREAMS[position.s]
      if (!stream) return { signals: [], nextCursor: null }

      const data = await query(
        stream.document,
        { first: PAGE_SIZE, after: position.after },
        ctx,
      )
      const connection = (data[stream.field] ?? {}) as {
        nodes?: unknown
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
      }
      const nodes = Array.isArray(connection.nodes)
        ? (connection.nodes as Record<string, unknown>[])
        : []

      const signals = nodes.map((node) => toSignal(stream, node, restricted(ctx)))

      // Linear states both facts, so neither is inferred: `hasNextPage` says
      // whether to continue and `endCursor` says from where.
      const hasMore = Boolean(connection.pageInfo?.hasNextPage) && Boolean(connection.pageInfo?.endCursor)
      const next: Cursor = hasMore
        ? { s: position.s, after: connection.pageInfo!.endCursor! }
        : { s: position.s + 1, after: null }

      const finished = !hasMore && next.s >= LINEAR_STREAMS.length
      return { signals, nextCursor: finished ? null : JSON.stringify(next) }
    },

    async handleWebhook(
      request: WebhookRequest,
      ctx: ConnectorContext,
    ): Promise<readonly Signal[]> {
      const payload = JSON.parse(request.body) as { type?: string; data?: Record<string, unknown> }
      const stream = LINEAR_STREAMS.find((candidate) => candidate.webhookType === payload.type)
      if (!stream || !payload.data) return []
      return [toSignal(stream, payload.data, restricted(ctx))]
    },

    /**
     * The deterministic extraction pass (AC5).
     *
     * Reads what the source already states — this issue is a ticket, its
     * creator is a person — and infers nothing. Resolution and persistence are
     * BRAIN-3's; a connector's part ends at "here is what this signal plainly
     * says exists".
     */
    mapExternal(signal: Signal): readonly EntityCandidate[] {
      return candidatesFor(signal)
    },

    async health(ctx: ConnectorContext): Promise<HealthStatus> {
      try {
        await query('query { viewer { id name } }', {}, ctx)
        return { state: 'ok', checkedAt: ctx.now() }
      } catch (error) {
        if (error instanceof RateLimitedError) {
          return {
            state: 'degraded',
            checkedAt: ctx.now(),
            problem: 'Linear is rate limiting this integration.',
            remedy: 'No action needed — syncing resumes automatically after the requested delay.',
          }
        }
        const status = (error as UpstreamError).details?.status
        if (status === 401 || status === 400) {
          return {
            state: 'failed',
            checkedAt: ctx.now(),
            problem: 'The Linear access token was rejected and could not be refreshed.',
            remedy:
              'Reconnect Linear for this workspace. If the authorisation was revoked in Linear, it must be granted again there first.',
          }
        }
        return {
          state: 'degraded',
          checkedAt: ctx.now(),
          problem: `Linear did not answer a health check: ${(error as Error).message}`,
          remedy: 'No action needed yet — this is usually transient. Investigate if it persists.',
        }
      }
    },
  }
}
