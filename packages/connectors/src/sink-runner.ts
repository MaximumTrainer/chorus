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
