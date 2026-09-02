import { NotFoundError, ValidationError, parseSignal, ulid, type Signal } from '@chorus/core'
import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'
import type { Connector, ConnectorContext, WebhookRequest } from './contract.js'
import type { CredentialStore } from './credentials.js'

/**
 * The webhook receiver (INT-1 AC3).
 *
 * A webhook endpoint is the one part of the system an unauthenticated stranger
 * reaches on purpose, and the one place a source will cheerfully deliver the
 * same event three times. Three properties, and the **order** of the first two
 * is itself a security property:
 *
 *  1. **Verify, then deduplicate.** The other way round, an attacker who
 *     guesses a delivery id gets the genuine delivery discarded later as a
 *     repeat — a forgery that suppresses real data without ever being accepted.
 *  2. **Deduplicate in the database.** By unique index, not a read-then-write,
 *     which is a race the moment a source retries in parallel with its first
 *     attempt.
 *  3. **Store everything, replay only what verified.** Replay is the only
 *     practical way to debug a connector against a source you cannot reproduce
 *     — yesterday's payload, today's code — but replaying an unverified payload
 *     would make the debugging endpoint a way to get a forgery executed later.
 */

export type DeliveryState =
  | 'processed'
  /** Already seen, by delivery id. The signals it carried are already stored. */
  | 'duplicate'
  /** Forged, or missing the identifier deduplication depends on. */
  | 'rejected'
  /** Verified and accepted, but the connector could not map it. Retryable. */
  | 'failed'

export interface DeliveryOutcome {
  readonly state: DeliveryState
  readonly deliveryId: string | null
  /** Signals written. Excludes any the source had already delivered. */
  readonly ingested: number
  readonly reason?: string
}

export interface WebhookReceiverDeps {
  readonly now?: () => Date
}

export interface WebhookReceiver {
  receive(
    workspaceId: string,
    integrationId: string,
    connector: Connector,
    request: WebhookRequest,
  ): Promise<DeliveryOutcome>
  /**
   * Re-runs the connector over a stored delivery.
   *
   * Deliberately re-runs rather than returning what was stored: the point is to
   * put today's mapping code over yesterday's payload, and a replay that
   * returned the recorded result would prove nothing about the connector.
   */
  replay(
    workspaceId: string,
    integrationId: string,
    connector: Connector,
    deliveryId: string,
  ): Promise<DeliveryOutcome>
}

export function createWebhookReceiver(
  config: DbConfig,
  credentials: CredentialStore,
  deps: WebhookReceiverDeps = {},
): WebhookReceiver {
  const now = deps.now ?? (() => new Date())

  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>): Promise<T> =>
    withTenant(workspaceId, fn, { config })

  /**
   * Writes the signals a delivery carried, and marks it processed, atomically.
   *
   * Same reasoning as the sync runner's page commit: marking a delivery
   * processed without its signals loses them, and writing signals without
   * marking it processed re-runs the effects on the next retry.
   */
  async function commit(
    workspaceId: string,
    integrationId: string,
    source: string,
    deliveryRowId: string,
    signals: readonly Signal[],
  ): Promise<number> {
    return tx(workspaceId, async (t) => {
      let ingested = 0
      for (const signal of signals) {
        ingested += await t.execute(
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
      }

      await t.execute(
        `UPDATE webhook_deliveries SET processed_at = $1, error = NULL WHERE id = $2`,
        [now(), deliveryRowId],
      )
      return ingested
    })
  }

  /** Runs the connector over a request and stores what it produced. */
  async function handle(
    workspaceId: string,
    integrationId: string,
    connector: Connector,
    request: WebhookRequest,
    deliveryRowId: string,
    ctx: ConnectorContext,
  ): Promise<DeliveryOutcome> {
    const deliveryId = connector.webhooks!.deliveryId(request)
    try {
      const signals = (await connector.handleWebhook!(request, ctx)) ?? []
      // Validated before anything is written, exactly as on the pull path: a
      // connector's mistake fails its delivery rather than becoming a permanent
      // row that retrieval will later mis-permission.
      signals.forEach((signal) => parseSignal(signal))

      const ingested = await commit(
        workspaceId,
        integrationId,
        connector.kind,
        deliveryRowId,
        signals,
      )
      return { state: 'processed', deliveryId, ingested }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Left unprocessed on purpose, so a retry or a replay attempts it again
      // rather than treating a failure as a completed delivery.
      await tx(workspaceId, (t) =>
        t.execute(`UPDATE webhook_deliveries SET error = $1 WHERE id = $2`, [
          message,
          deliveryRowId,
        ]),
      )
      return { state: 'failed', deliveryId, ingested: 0, reason: message }
    }
  }

  async function contextFor(
    workspaceId: string,
    integrationId: string,
  ): Promise<{ ctx: ConnectorContext; secrets: Record<string, string> }> {
    const integration = await credentials.get(workspaceId, integrationId)
    const secrets = await credentials.credentialsFor(workspaceId, integrationId)
    return {
      secrets,
      ctx: { workspaceId, integrationId, credentials: secrets, config: integration.config, now },
    }
  }

  return {
    async receive(workspaceId, integrationId, connector, request) {
      if (!connector.webhooks || !connector.handleWebhook) {
        throw new ValidationError('This connector does not accept webhooks', {
          kind: connector.kind,
        })
      }

      const { ctx, secrets } = await contextFor(workspaceId, integrationId)
      const deliveryId = connector.webhooks.deliveryId(request)

      // Verification first — before the delivery id is trusted for anything.
      // Deduplicating first would let a forgery claim a delivery id and have
      // the genuine delivery discarded later as a repeat.
      const secret = secrets[connector.webhooks.secretKey] ?? ''
      const signatureOk = secret !== '' && connector.webhooks.verify(request, secret)

      // A delivery with no identifier cannot be deduplicated. Refused rather
      // than accepted: at-least-once delivery with no way to collapse repeats
      // is worse than a refusal, because it is invisible.
      if (!deliveryId) {
        return {
          state: 'rejected',
          deliveryId: null,
          ingested: 0,
          reason: 'the delivery carried no identifier, so it cannot be deduplicated',
        }
      }

      const rowId = ulid()
      const inserted = await tx(workspaceId, (t) =>
        t.execute(
          `INSERT INTO webhook_deliveries
             (id, workspace_id, integration_id, delivery_id, signature_ok, headers, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (integration_id, delivery_id) DO NOTHING`,
          [
            rowId,
            workspaceId,
            integrationId,
            deliveryId,
            signatureOk,
            JSON.stringify(request.headers),
            request.body,
          ],
        ),
      )

      if (inserted === 0) {
        // The unique index refused it: this delivery id has been seen. A
        // forgery that lost the race to a genuine delivery lands here too,
        // which is correct — the genuine one was processed.
        const [existing] = await tx(workspaceId, (t) =>
          t.query<{ signature_ok: boolean; processed_at: Date | null }>(
            `SELECT signature_ok, processed_at FROM webhook_deliveries
              WHERE integration_id = $1 AND delivery_id = $2`,
            [integrationId, deliveryId],
          ),
        )

        // A stored forgery must not block the genuine delivery that follows it.
        // Its row is replaced rather than kept, so the real payload is what is
        // available to replay.
        if (existing && !existing.signature_ok && signatureOk) {
          await tx(workspaceId, (t) =>
            t.execute(
              `UPDATE webhook_deliveries
                  SET signature_ok = true, headers = $1, payload = $2, error = NULL,
                      received_at = $3, id = $4
                WHERE integration_id = $5 AND delivery_id = $6`,
              [
                JSON.stringify(request.headers),
                request.body,
                now(),
                rowId,
                integrationId,
                deliveryId,
              ],
            ),
          )
          return handle(workspaceId, integrationId, connector, request, rowId, ctx)
        }

        return { state: 'duplicate', deliveryId, ingested: 0 }
      }

      if (!signatureOk) {
        // Recorded, not silently dropped: a run of forged deliveries is worth
        // being able to see. It stays unprocessed and unreplayable.
        return {
          state: 'rejected',
          deliveryId,
          ingested: 0,
          reason: 'the signature did not verify',
        }
      }

      return handle(workspaceId, integrationId, connector, request, rowId, ctx)
    },

    async replay(workspaceId, integrationId, connector, deliveryId) {
      if (!connector.webhooks || !connector.handleWebhook) {
        throw new ValidationError('This connector does not accept webhooks', {
          kind: connector.kind,
        })
      }

      const [row] = await tx(workspaceId, (t) =>
        t.query<{ id: string; signature_ok: boolean; headers: Record<string, string>; payload: string }>(
          `SELECT id, signature_ok, headers, payload FROM webhook_deliveries
            WHERE integration_id = $1 AND delivery_id = $2`,
          [integrationId, deliveryId],
        ),
      )
      if (!row) throw new NotFoundError('No such delivery', { deliveryId })

      // Replaying an unverified payload would turn the debugging endpoint into
      // a way to get a forgery executed later, by whoever can reach it.
      if (!row.signature_ok) {
        throw new ValidationError('That delivery never verified, so it cannot be replayed', {
          deliveryId,
        })
      }

      const { ctx } = await contextFor(workspaceId, integrationId)
      // The stored raw body, byte for byte — which is what makes a replay
      // verify the way the original did.
      const request: WebhookRequest = { headers: row.headers, body: row.payload }
      return handle(workspaceId, integrationId, connector, request, row.id, ctx)
    },
  }
}
