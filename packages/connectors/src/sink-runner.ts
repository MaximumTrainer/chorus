import { AppError } from '@chorus/core'
import type { ConnectorContext, ExternalRef, SinkAction } from './contract.js'

/**
 * Runs one sink action idempotently (INT-4 AC2).
 *
 * The framework owns the ordering, not each connector, for the same reason it
 * owns "a null cursor means caught up": a guarantee written once is a guarantee,
 * and a guarantee re-implemented per connector is a guarantee until the one
 * that got it wrong. `find` before `execute` is that ordering — search before
 * create.
 *
 * It is what makes the production case survivable. A create whose response is
 * lost to a timeout has still happened at the source; the caller, seeing no
 * answer, retries with the same key; `find` locates the object the first call
 * made and returns it, so exactly one exists. An action whose provider
 * deduplicates on the key itself omits `find` and relies on `execute` passing
 * the key through — the wrapper then simply calls `execute`, and the provider
 * collapses the retry.
 */
export async function runSinkAction<I>(
  action: SinkAction<I>,
  input: I,
  idempotencyKey: string,
  ctx: ConnectorContext,
): Promise<ExternalRef> {
  const existing = await action.find?.(idempotencyKey, ctx)
  if (existing) return existing
  return action.execute(input, idempotencyKey, ctx)
}

/** One item of a bulk sink operation: its input and the key that dedupes it. */
export interface SinkBatchItem<I = unknown> {
  readonly idempotencyKey: string
  readonly input: I
}

/**
 * What became of one item in a bulk operation (INT-4 AC4).
 *
 * A failure says whether it is worth retrying — a rate limit is, a rejected
 * input is not — because the caller's next move depends entirely on which it
 * was, and a batch that collapsed the two would have the caller either retry a
 * permanent failure forever or abandon a transient one.
 */
export type SinkItemOutcome =
  | { readonly status: 'ok'; readonly ref: ExternalRef }
  | { readonly status: 'failed'; readonly error: string; readonly retryable: boolean }

/**
 * Runs a bulk sink operation, reporting a per-item outcome (INT-4 AC4).
 *
 * The property that matters is the partial failure: some items land, some do
 * not, and the caller has to be told precisely which. So one item's failure
 * never fails the batch — each is attempted and its outcome recorded in order.
 * Nothing is rolled back, because each write is independent and undoing a
 * create in someone else's tracker is not ours to do; and because every item
 * carries its own idempotency key, retrying the whole batch re-attempts only
 * the failures while `runSinkAction`'s search-before-create resolves the
 * successes to the objects they already made rather than duplicating them.
 *
 * Retryability is read from the error's own contract (`AppError.retryable`),
 * not re-decided here: a rate limit or a transient upstream failure is
 * retryable, a validation or permission failure is not, and the connector that
 * raised it is the one that knows which.
 */
export async function runSinkBatch<I>(
  action: SinkAction<I>,
  items: readonly SinkBatchItem<I>[],
  ctx: ConnectorContext,
): Promise<readonly SinkItemOutcome[]> {
  const outcomes: SinkItemOutcome[] = []
  for (const item of items) {
    try {
      const ref = await runSinkAction(action, item.input, item.idempotencyKey, ctx)
      outcomes.push({ status: 'ok', ref })
    } catch (error) {
      outcomes.push({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        retryable: error instanceof AppError ? error.retryable : false,
      })
    }
  }
  return outcomes
}
