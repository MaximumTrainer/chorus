import { createHmac, timingSafeEqual } from 'node:crypto'
import { RateLimitedError, type ConnectorKind, type Signal } from '@chorus/core'
import type {
  Capabilities,
  Connector,
  ConnectorContext,
  AuthSpec,
  HealthStatus,
  PullResult,
  WebhookRequest,
  WebhookSpec,
} from '../contract.js'

/**
 * The reference connector (INT-1, implementation notes).
 *
 * Deliberately simple, and deliberately *scriptable*. It exists to keep the
 * interface honest before a real API distorts it: the contract kit runs against
 * this first, so a guarantee that turns out to be awkward to state gets fixed
 * in the framework rather than worked around in every connector.
 *
 * Scriptability is the other half of its job. The kit has to demand behaviours
 * a real source will not produce on request — an expired credential, an empty
 * page, a run of pages that ends — and a connector that cannot be told to
 * misbehave can only ever be tested on its happy path.
 *
 * It ships in `src/`, not in a test file, because a kit that only ran against
 * test-local fixtures would not demonstrate that the interface is implementable
 * by somebody else.
 */

export interface ReferenceItem {
  readonly id: string
  readonly text: string
  readonly at: string
  readonly author?: string
  readonly restrictedTo?: string
}

export interface ReferenceScript {
  /** The corpus, served one page at a time. */
  readonly items?: readonly ReferenceItem[]
  readonly pageSize?: number
  /** Forces health to fail, as an expired or revoked credential would. */
  readonly credentialExpired?: boolean
  /** Makes the next pull raise a rate limit, with this delay in milliseconds. */
  readonly rateLimitedAfterMs?: number
}

export interface ReferenceConnector extends Connector {
  /** Rewrites the script between calls, so one test can change the world. */
  script(next: ReferenceScript): void
  /** Every cursor the connector has been asked to resume from, in order. */
  readonly cursorsSeen: readonly (string | null)[]
}

const DEFAULT_ITEMS: readonly ReferenceItem[] = Object.freeze([
  { id: 'item-1', text: 'the first thing that happened', at: '2026-09-01T09:00:00.000Z', author: 'ada' },
  { id: 'item-2', text: 'the second thing', at: '2026-09-01T10:00:00.000Z', author: 'grace' },
  { id: 'item-3', text: 'a restricted thing', at: '2026-09-01T11:00:00.000Z', restrictedTo: 'room-1' },
  { id: 'item-4', text: 'the fourth thing', at: '2026-09-01T12:00:00.000Z', author: 'ada' },
  { id: 'item-5', text: 'the last thing', at: '2026-09-01T13:00:00.000Z', author: 'grace' },
])

/**
 * The cursor is the id of the last item handed out.
 *
 * An offset would be simpler and wrong: a source that inserts an item between
 * pages shifts every offset after it, so an offset cursor silently skips or
 * repeats exactly when the corpus is busiest.
 */
function pageAfter(
  items: readonly ReferenceItem[],
  cursor: string | null,
  pageSize: number,
): { page: readonly ReferenceItem[]; nextCursor: string | null } {
  const start = cursor === null ? 0 : items.findIndex((item) => item.id === cursor) + 1
  const page = items.slice(start, start + pageSize)
  const consumed = start + page.length
  return {
    page,
    // Null means caught up. Returning the last id instead would make every
    // sync end with one wasted empty page.
    nextCursor: consumed >= items.length ? null : (page[page.length - 1]?.id ?? null),
  }
}

function toSignal(item: ReferenceItem): Signal {
  return {
    source: 'reference' as ConnectorKind,
    externalId: item.id,
    kind: 'message',
    text: item.text,
    structured: { at: item.at },
    author: item.author ? { externalId: item.author, display: item.author } : null,
    occurredAt: new Date(item.at),
    url: `https://reference.test/items/${item.id}`,
    permissions: item.restrictedTo
      ? { visibility: 'restricted', scopeIds: [item.restrictedTo] }
      : { visibility: 'public', scopeIds: [] },
    raw: item,
  }
}

/**
 * A plausible signing scheme: HMAC-SHA256 of the raw body, hex, in a header.
 *
 * Modelled on what most real sources do, so the framework's ordering guarantees
 * are exercised against something with the same shape as GitHub's or Slack's
 * rather than against a stub that always returns true.
 */
const webhooks: WebhookSpec = {
  secretKey: 'webhookSecret',
  verification: 'signature',

  deliveryId(request: WebhookRequest) {
    return request.headers['x-reference-delivery'] ?? null
  },

  verify(request: WebhookRequest, secret: string) {
    const presented = request.headers['x-reference-signature'] ?? ''
    const expected = createHmac('sha256', secret).update(request.body).digest('hex')
    const a = Buffer.from(presented, 'utf8')
    const b = Buffer.from(expected, 'utf8')
    // Length is compared first because timingSafeEqual throws on a mismatch,
    // and a presented signature's length is entirely the caller's choice.
    return a.length === b.length && timingSafeEqual(a, b)
  },
}

export function createReferenceConnector(initial: ReferenceScript = {}): ReferenceConnector {
  let current: ReferenceScript = { items: DEFAULT_ITEMS, pageSize: 2, ...initial }
  const cursorsSeen: (string | null)[] = []

  const auth: AuthSpec = { kind: 'none' }
  const capabilities: Capabilities = { source: true }

  return {
    kind: 'reference',
    auth,
    capabilities,

    script(next) {
      current = { ...current, ...next }
    },

    get cursorsSeen() {
      return cursorsSeen
    },

    async pull(cursor: string | null, _ctx: ConnectorContext): Promise<PullResult> {
      cursorsSeen.push(cursor)
      if (current.rateLimitedAfterMs !== undefined) {
        throw new RateLimitedError('The source applied a rate limit', {
          retryAfterMs: current.rateLimitedAfterMs,
        })
      }
      const { page, nextCursor } = pageAfter(
        current.items ?? [],
        cursor,
        current.pageSize ?? 2,
      )
      return { signals: page.map(toSignal), nextCursor }
    },

    webhooks,

    async handleWebhook(
      request: WebhookRequest,
      _ctx: ConnectorContext,
    ): Promise<readonly Signal[]> {
      const item = JSON.parse(request.body) as ReferenceItem
      return [toSignal(item)]
    },

    async health(ctx: ConnectorContext): Promise<HealthStatus> {
      if (current.credentialExpired) {
        return {
          state: 'failed',
          checkedAt: ctx.now(),
          problem: 'The stored credential has expired.',
          remedy: 'Reconnect this integration to issue a new credential.',
        }
      }
      return { state: 'ok', checkedAt: ctx.now() }
    },
  }
}
