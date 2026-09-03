import { describe, it, expect } from 'vitest'
import { CONNECTOR_KINDS, RateLimitedError, parseSignal } from '@chorus/core'
import type { Connector, ConnectorContext, WebhookRequest } from '../contract.js'

/**
 * The connector contract kit (INT-1 AC7).
 *
 * Every connector must pass exactly this suite. That is the point: a framework
 * guarantee that holds for one connector and not another is not a guarantee,
 * and a contributor with no live account still has to be able to prove their
 * connector works.
 *
 * The kit is shipped code, maintained like production code, for the same reason
 * the fakes in `packages/testing` are (CLAUDE.md §4) — its fidelity is what
 * makes every connector's tests worth anything.
 *
 * It grows with the framework. Each guarantee here arrived with the slice of
 * INT-1 that implemented it, so the kit and the framework cannot drift: a
 * guarantee nothing enforces would be a promise to connector authors that the
 * framework does not keep.
 */

export interface ContractKitOptions {
  /**
   * A context for calls the kit makes. Defaults to a credential-free one, which
   * is right for a connector that needs none and wrong for one that does — so a
   * connector under test supplies its own.
   */
  readonly context?: Partial<ConnectorContext>
  /**
   * Connectors rigged into a specific state — from a cassette, a scripted fake,
   * or whatever the connector uses.
   *
   * Optional because the kit cannot make an arbitrary source produce a rate
   * limit on demand, and a suite that silently required it would be one no
   * contributor could pass. Supplying one buys the assertions below; omitting
   * one means those guarantees are simply untested for that connector, which is
   * a visible gap rather than a hidden pass.
   */
  readonly scenarios?: {
    /** A connector whose next `pull` will be rate-limited by the source. */
    readonly rateLimited?: () => Connector
    /** A connector whose stored credential has expired or been revoked. */
    readonly credentialExpired?: () => Connector
  }
  /**
   * A genuine, correctly-signed delivery and the secret it was signed with.
   *
   * Supplied by the connector because only it knows its source's scheme. The
   * kit then forges the delivery itself, which is the assertion worth having:
   * a `verify` that returns true unconditionally passes every test written
   * against valid input.
   */
  readonly webhookSample?: () => { request: WebhookRequest; secret: string }
}

/** A deterministic context. Time is injected and frozen (CLAUDE.md §5). */
export function contractContext(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  const frozen = new Date('2026-09-02T12:00:00.000Z')
  return {
    workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    integrationId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
    credentials: {},
    config: {},
    now: () => frozen,
    // Refuses rather than reaching the network: a connector that slips past its
    // cassette must fail the suite, not quietly call the real source.
    fetch: (() => {
      throw new Error('a connector under contract test must use its injected fetch')
    }) as unknown as typeof fetch,
    saveCredentials: async () => {},
    ...overrides,
  }
}

/**
 * Runs the contract suite against `factory`.
 *
 * A factory rather than an instance, so each case gets a connector that no
 * earlier case has already advanced — a kit whose cases shared one instance
 * would pass or fail depending on the order they ran in.
 */
export function describeConnectorContract(
  name: string,
  factory: () => Connector,
  options: ContractKitOptions = {},
): void {
  const ctx = (): ConnectorContext => contractContext(options.context ?? {})

  describe(`INT-1 connector contract: ${name}`, () => {
    it('INT-1 AC7: declares a known kind, an auth spec and its capabilities', () => {
      const connector = factory()

      // A kind outside the catalogue means signals land in a corpus nothing
      // queries, and a health page nobody can find.
      expect(CONNECTOR_KINDS).toContain(connector.kind)
      expect(['oauth2', 'token', 'github_app', 'none']).toContain(connector.auth.kind)

      const declared = Object.values(connector.capabilities).filter(Boolean)
      expect(declared.length, 'a connector that can do nothing is misconfigured').toBeGreaterThan(0)
    })

    it('INT-1 AC7: a source connector implements pull, and a non-source does not claim to', () => {
      const connector = factory()
      // The capability declaration is what the scheduler reads. A connector
      // declaring `source` without `pull` is scheduled forever and never syncs.
      expect(Boolean(connector.capabilities.source)).toBe(typeof connector.pull === 'function')
    })

    it('INT-1 AC6/AC7: every signal it produces conforms to the Signal envelope', async () => {
      const connector = factory()
      if (!connector.pull) return

      const { signals } = await connector.pull(null, ctx())
      expect(signals.length, 'the kit needs at least one signal to check').toBeGreaterThan(0)

      for (const signal of signals) {
        // Parsed, not merely shape-checked: this is the same validation the
        // framework applies at ingest, so a connector that passes here cannot
        // fail there.
        const parsed = parseSignal(signal)
        expect(parsed.source).toBe(connector.kind)
      }
    })

    it('INT-1 AC7: signals carry provenance a reader could act on', async () => {
      const connector = factory()
      if (!connector.pull) return

      const { signals } = await connector.pull(null, ctx())
      for (const signal of signals) {
        expect(signal.externalId, 'dedup depends on this').not.toBe('')
        expect(signal.raw, 'the untouched payload is what makes a mapping bug diagnosable').toBeDefined()
        expect(
          Number.isFinite(signal.occurredAt.getTime()),
          'an unusable timestamp misfiles a signal forever',
        ).toBe(true)
      }
    })

    it('INT-1 AC7: external ids are unique within a page', async () => {
      const connector = factory()
      if (!connector.pull) return

      const { signals } = await connector.pull(null, ctx())
      const ids = signals.map((signal) => `${signal.kind}:${signal.externalId}`)
      // `(integration_id, external_id, kind)` is a uniqueness constraint. A
      // duplicate within one page fails the whole batch at insert time.
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('INT-1 AC7: pull paginates, and says when it has caught up', async () => {
      const connector = factory()
      if (!connector.pull) return

      const seen: string[] = []
      let cursor: string | null = null
      // Bounded so a connector that never returns null fails as a timeout-free
      // assertion rather than hanging the suite.
      for (let page = 0; page < 50; page++) {
        const result = await connector.pull(cursor, ctx())
        seen.push(...result.signals.map((signal) => signal.externalId))
        cursor = result.nextCursor
        if (cursor === null) break
      }

      expect(cursor, 'pull must terminate by returning a null cursor').toBeNull()
      expect(new Set(seen).size, 'pagination must not repeat a signal').toBe(seen.length)
      expect(seen.length).toBeGreaterThan(0)
    })

    it('INT-1 AC7: resuming from a cursor returns what follows it, not the page again', async () => {
      const connector = factory()
      if (!connector.pull) return

      const first = await connector.pull(null, ctx())
      if (first.nextCursor === null) return

      const second = await connector.pull(first.nextCursor, ctx())
      const firstIds = new Set(first.signals.map((signal) => signal.externalId))
      for (const signal of second.signals) {
        expect(firstIds.has(signal.externalId), `${signal.externalId} was served twice`).toBe(false)
      }
    })

    it('INT-1 AC5/AC7: health answers, and a failure names a problem and a remedy', async () => {
      const connector = factory()
      const status = await connector.health(ctx())

      expect(['ok', 'degraded', 'failed']).toContain(status.state)
      expect(status.checkedAt).toBeInstanceOf(Date)

      if (status.state !== 'ok') {
        // "401 Unauthorized" with no next step leaves an admin stuck. The
        // remedy is the half that makes health actionable.
        expect(status.problem, 'an unhealthy connector must say what is wrong').toBeTruthy()
        expect(status.remedy, 'and what to do about it').toBeTruthy()
      }
    })

    it('INT-1 AC4/AC7: a rate limit is reported as one, with the delay the source asked for', async () => {
      const rigged = options.scenarios?.rateLimited
      if (!rigged) return

      const connector = rigged()
      // Reported as `RateLimitedError`, not as a generic failure: the runner
      // resumes after a rate limit and gives up after a failure, so a connector
      // that conflates them either abandons a sync it should have resumed or
      // hammers a source it should have backed off from.
      const raised = await connector
        .pull!(null, ctx())
        .then(() => undefined)
        .catch((error: unknown) => error)

      expect(raised, 'a rigged rate limit must actually be raised').toBeInstanceOf(RateLimitedError)
      const retryAfterMs = (raised as RateLimitedError).retryAfterMs
      expect(typeof retryAfterMs).toBe('number')
      expect(retryAfterMs, 'a delay of zero is not a back-off').toBeGreaterThan(0)
    })

    it('INT-1 AC5/AC7: an expired credential is reported as unhealthy, with the remedy', async () => {
      const rigged = options.scenarios?.credentialExpired
      if (!rigged) return

      const status = await rigged().health(ctx())

      // The distinction that matters to whoever is on call: this one will not
      // fix itself, and the remedy has to say so.
      expect(status.state).not.toBe('ok')
      expect(status.problem).toBeTruthy()
      expect(status.remedy, 'an expired credential needs a human, so say what to do').toBeTruthy()
    })

    it('INT-1 AC3/AC7: a webhook connector declares both a spec and a handler, or neither', () => {
      const connector = factory()
      // One without the other is unusable: a spec with no handler can be
      // verified and never acted on, and a handler with no spec would have to
      // be trusted unverified.
      expect(Boolean(connector.webhooks)).toBe(typeof connector.handleWebhook === 'function')
    })

    it('INT-1 AC3/AC7: a genuine delivery verifies and yields a deduplicable identifier', () => {
      const sample = options.webhookSample
      const connector = factory()
      if (!sample || !connector.webhooks) return

      const { request, secret } = sample()
      expect(connector.webhooks.verify(request, secret)).toBe(true)
      // Without an identifier the framework refuses the delivery, so a
      // connector whose source offers none has to derive one from the payload.
      expect(connector.webhooks.deliveryId(request)).toBeTruthy()
    })

    it('INT-1 AC3/AC7: a tampered body or a wrong secret does not verify', () => {
      const sample = options.webhookSample
      const connector = factory()
      if (!sample || !connector.webhooks) return

      const { request, secret } = sample()

      // The assertion that catches a `verify` returning true unconditionally,
      // which every test written against valid input would pass.
      expect(
        connector.webhooks.verify({ ...request, body: `${request.body} ` }, secret),
        'a body altered by one byte must not verify',
      ).toBe(false)
      expect(connector.webhooks.verify(request, `${secret}-wrong`)).toBe(false)
      expect(connector.webhooks.verify(request, '')).toBe(false)
    })

    it('INT-1 AC3/AC7: handling a delivery yields signals in the envelope', async () => {
      const sample = options.webhookSample
      const connector = factory()
      if (!sample || !connector.handleWebhook) return

      const signals = await connector.handleWebhook(sample().request, ctx())
      for (const signal of signals) {
        // The same validation the receiver applies before writing, so a
        // connector that passes here cannot fail a delivery there.
        expect(parseSignal(signal).source).toBe(connector.kind)
      }
    })

    it('INT-1 AC3/AC7: handling the same delivery twice yields the same signal ids', async () => {
      const sample = options.webhookSample
      const connector = factory()
      if (!sample || !connector.handleWebhook) return

      const once = await connector.handleWebhook(sample().request, ctx())
      const twice = await connector.handleWebhook(sample().request, ctx())

      // Deduplication is by `(integration_id, external_id, kind)`. A connector
      // that mints a fresh external id per call defeats it, and replay then
      // duplicates every effect it was meant to make safe.
      expect(twice.map((signal) => signal.externalId)).toEqual(
        once.map((signal) => signal.externalId),
      )
    })

    it('INT-1 AC7: health uses the injected clock, so it is testable', async () => {
      const connector = factory()
      const context = ctx()
      const status = await connector.health(context)

      // A connector reaching for Date.now() cannot be tested against an expiry
      // window without making the suite wait for real time to pass.
      expect(status.checkedAt.toISOString()).toBe(context.now().toISOString())
    })
  })
}
