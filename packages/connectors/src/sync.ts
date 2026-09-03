import {
  RateLimitedError,
  parseSignal,
  ulid,
  type Signal,
} from '@chorus/core'
import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'
import type { Connector, ConnectorContext, HealthStatus } from './contract.js'
import type { CredentialStore } from './credentials.js'

/**
 * The sync runner (INT-1 AC2, AC4, AC5).
 *
 * One guarantee, with two halves that pull against each other: work is never
 * lost and never repeated. A runner that commits its cursor before its signals
 * loses a page to a crash; one that commits signals without a cursor re-ingests
 * the same page forever. Both are committed in the *same transaction*, per
 * page, which is the only arrangement that is neither.
 *
 * The runner does not sleep. A rate limit ends the sync with the delay the
 * source asked for, and the scheduler re-enqueues — so backing off costs a
 * worker nothing, and the behaviour is testable without a test that waits
 * (CLAUDE.md §5).
 */

export type SyncState =
  /** Nothing left to fetch. */
  | 'caught_up'
  /** Stopped at a page limit, with more to come. Not an error. */
  | 'interrupted'
  /** The source asked us to slow down. Resume after `retryAfterMs`. */
  | 'rate_limited'
  | 'failed'

export interface SyncOutcome {
  readonly state: SyncState
  readonly pages: number
  /** Signals written. Excludes ones the source repeated. */
  readonly ingested: number
  /** Signals the source served again, refused by the uniqueness index. */
  readonly duplicates: number
  readonly cursor: string | null
  readonly retryAfterMs?: number
  readonly error?: string
}

export interface SyncOptions {
  /** Stops after this many pages. A restart is what this stands in for in tests. */
  readonly maxPages?: number
}

export interface SyncRunnerDeps {
  /** Injected and frozen in tests (CLAUDE.md §5). */
  readonly now?: () => Date
  /** The network the connectors get. A cassette player in tests. */
  readonly fetch?: typeof fetch
  /** A ceiling, so a connector with a broken cursor cannot loop forever. */
  readonly maxPagesPerRun?: number
}

export interface SyncRunner {
  sync(
    workspaceId: string,
    integrationId: string,
    connector: Connector,
    options?: SyncOptions,
  ): Promise<SyncOutcome>
}

const DEFAULT_MAX_PAGES = 1_000

/**
 * Redacts anything that looks like one of this integration's credentials.
 *
 * A connector that interpolates its context into an error message is exactly
 * how a credential reaches a health page an admin can read — and the connector
 * is third-party code, so this cannot be left to its good manners.
 */
function redact(message: string, credentials: Readonly<Record<string, string>>): string {
  let safe = message
  for (const value of Object.values(credentials)) {
    if (value.length >= 4) safe = safe.split(value).join('[redacted]')
  }
  return safe
}

export function createSyncRunner(
  config: DbConfig,
  credentials: CredentialStore,
  deps: SyncRunnerDeps = {},
): SyncRunner {
  const now = deps.now ?? (() => new Date())
  const http = deps.fetch ?? fetch
  const ceiling = deps.maxPagesPerRun ?? DEFAULT_MAX_PAGES

  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>): Promise<T> =>
    withTenant(workspaceId, fn, { config })

  /**
   * Writes one page and its cursor, atomically.
   *
   * `ON CONFLICT DO NOTHING` makes ingestion idempotent in the database rather
   * than by a read-then-write in the application, which is a race the moment a
   * sync and a webhook delivery arrive together.
   */
  async function commitPage(
    workspaceId: string,
    integrationId: string,
    source: string,
    signals: readonly Signal[],
    nextCursor: string | null,
  ): Promise<{ ingested: number; duplicates: number }> {
    return tx(workspaceId, async (t) => {
      let ingested = 0

      for (const signal of signals) {
        const written = await t.execute(
          `INSERT INTO signals
             (id, workspace_id, integration_id, source, external_id, kind, text, structured,
              author, author_display, occurred_at, url, permissions, raw)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (integration_id, external_id, kind) DO NOTHING`,
          [
            ulid(),
            workspaceId,
            integrationId,
            source,
            signal.externalId,
            signal.kind,
            signal.text,
            JSON.stringify(signal.structured ?? null),
            signal.author?.externalId ?? null,
            signal.author?.display ?? null,
            signal.occurredAt,
            signal.url,
            JSON.stringify(signal.permissions),
            JSON.stringify(signal.raw ?? null),
          ],
        )
        ingested += written
      }

      await t.execute(
        `UPDATE integrations SET sync_cursor = $1, updated_at = now() WHERE id = $2`,
        [nextCursor, integrationId],
      )

      return { ingested, duplicates: signals.length - ingested }
    })
  }

  /**
   * Records health, preserving the last success.
   *
   * "Failing since 09:00, last worked at 08:55" is the sentence an admin needs;
   * dropping the last success on failure deletes half of it.
   */
  async function recordHealth(
    workspaceId: string,
    integrationId: string,
    status: 'connected' | 'degraded' | 'failed',
    health: Record<string, unknown>,
  ): Promise<void> {
    await tx(workspaceId, (t) =>
      t.execute(
        `UPDATE integrations
            SET status = $1,
                health = COALESCE(health, '{}'::jsonb) || $2::jsonb,
                updated_at = now()
          WHERE id = $3`,
        [status, JSON.stringify(health), integrationId],
      ),
    )
  }

  return {
    async sync(workspaceId, integrationId, connector, options = {}) {
      const integration = await credentials.get(workspaceId, integrationId)
      const secrets = await credentials.credentialsFor(workspaceId, integrationId)

      const ctx: ConnectorContext = {
        workspaceId,
        integrationId,
        credentials: secrets,
        config: integration.config,
        now,
        fetch: http,
        saveCredentials: (next) => credentials.updateCredentials(workspaceId, integrationId, next),
      }

      if (!connector.pull) {
        return { state: 'caught_up', pages: 0, ingested: 0, duplicates: 0, cursor: null }
      }

      const limit = Math.min(options.maxPages ?? ceiling, ceiling)
      let cursor = integration.syncCursor
      let pages = 0
      let ingested = 0
      let duplicates = 0

      while (pages < limit) {
        let page: Awaited<ReturnType<NonNullable<Connector['pull']>>>
        try {
          page = await connector.pull(cursor, ctx)
          // Validated at the boundary (AC6), before anything is written. A
          // connector's mistake must fail its page, not become a permanent row
          // that retrieval will later mis-permission.
          page.signals.forEach((signal) => parseSignal(signal))
        } catch (error) {
          const rateLimited = error instanceof RateLimitedError
          const message = redact(
            error instanceof Error ? error.message : String(error),
            secrets,
          )

          await recordHealth(
            workspaceId,
            integrationId,
            rateLimited ? 'degraded' : 'failed',
            rateLimited
              ? {
                  state: 'degraded',
                  problem: `The source applied a rate limit: ${message}`,
                  remedy:
                    'No action needed — the sync will resume automatically after the requested delay.',
                  retryAfterMs: error.retryAfterMs,
                  checkedAt: now().toISOString(),
                }
              : {
                  state: 'failed',
                  problem: 'The last sync failed.',
                  remedy:
                    'Check the integration is still authorised, then retry the sync. Reconnect if the credential has been revoked.',
                  lastError: message,
                  checkedAt: now().toISOString(),
                },
          )

          return {
            state: rateLimited ? 'rate_limited' : 'failed',
            pages,
            ingested,
            duplicates,
            cursor,
            error: message,
            ...(rateLimited ? { retryAfterMs: error.retryAfterMs } : {}),
          }
        }

        const written = await commitPage(
          workspaceId,
          integrationId,
          connector.kind,
          page.signals,
          page.nextCursor,
        )
        ingested += written.ingested
        duplicates += written.duplicates
        cursor = page.nextCursor
        pages += 1

        if (cursor === null) break
      }

      const state: SyncState = cursor === null ? 'caught_up' : 'interrupted'

      // Health is only refreshed on a completed run. An interrupted one has not
      // learnt anything new about whether the source is well.
      if (state === 'caught_up') {
        const reported: HealthStatus = await connector.health(ctx)
        await recordHealth(
          workspaceId,
          integrationId,
          reported.state === 'ok' ? 'connected' : reported.state === 'degraded' ? 'degraded' : 'failed',
          {
            state: reported.state,
            checkedAt: reported.checkedAt.toISOString(),
            lastSuccessfulSyncAt: now().toISOString(),
            lastError: null,
            ...(reported.problem ? { problem: reported.problem } : {}),
            ...(reported.remedy ? { remedy: reported.remedy } : {}),
          },
        )
      }

      return { state, pages, ingested, duplicates, cursor }
    },
  }
}
