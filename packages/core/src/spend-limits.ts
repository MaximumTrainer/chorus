import { ValidationError } from './errors.js'
import type { SpendPeriod } from './spend-guard.js'

/**
 * A spend limit as an admin sets it (WS-7 AC3, architecture.md §9.3).
 *
 * The guard that enforces limits is NFR-8's (`evaluateSpendGuard`); this is
 * only the shape a limit must have to be enforceable as written. Everything
 * doubtful is refused rather than coerced: a limit is money, and a caller who
 * sent the string "100" or a fraction of a cent has misunderstood the field.
 */

export const SPEND_PERIODS: readonly SpendPeriod[] = ['day', 'month']

/** Ten million dollars. Beyond that the intent is "no limit", which omitting one already says. */
export const MAX_SPEND_LIMIT_CENTS = 1_000_000_000

export interface SpendLimitInput {
  readonly period: SpendPeriod
  readonly softLimitCents: number | null
  readonly hardLimitCents: number | null
}

function cents(body: Record<string, unknown>, field: 'softLimitCents' | 'hardLimitCents'): number | null {
  const value = body[field]
  if (value === undefined || value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_SPEND_LIMIT_CENTS
  ) {
    throw new ValidationError(
      `${field} must be a whole number of cents from 0 to ${MAX_SPEND_LIMIT_CENTS}, or null for none`,
      { field },
    )
  }
  return value
}

/**
 * The limit a request body describes, or `null` when it sets neither
 * threshold — a limit that limits nothing is a request to remove the limit.
 *
 * A whole replacement, not a merge: a threshold the body omits is unset. A
 * partial update that kept the old hard limit when only the soft one was sent
 * would leave the caller guessing which limit is now in force.
 */
export function parseSpendLimit(body: unknown): SpendLimitInput | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('A spend limit is an object', { field: 'body' })
  }
  const fields = body as Record<string, unknown>

  const period = fields.period ?? 'month'
  if (!(SPEND_PERIODS as readonly unknown[]).includes(period)) {
    throw new ValidationError(`period must be one of: ${SPEND_PERIODS.join(', ')}`, { field: 'period' })
  }

  const softLimitCents = cents(fields, 'softLimitCents')
  const hardLimitCents = cents(fields, 'hardLimitCents')
  if (softLimitCents === null && hardLimitCents === null) return null

  if (softLimitCents !== null && hardLimitCents !== null && softLimitCents > hardLimitCents) {
    // The hard limit refuses before the soft one could ask, so the checkpoint
    // it promises would never be raised.
    throw new ValidationError('softLimitCents must not exceed hardLimitCents', {
      field: 'softLimitCents',
    })
  }

  return { period: period as SpendPeriod, softLimitCents, hardLimitCents }
}
