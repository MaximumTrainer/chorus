/**
 * The spend guard's decision (NFR-8, architecture.md §9.3).
 *
 * Given what each binding scope has spent this period and what the call about
 * to be made is estimated to cost, decide whether it may go ahead. Pure, and
 * here once, so the answer to "does this cross a limit" cannot differ between
 * whoever asks it.
 *
 * The estimate is priced in rather than added afterwards. A limit checked only
 * against spend already incurred is crossed by the call that crosses it, and
 * the checkpoint that follows is a notification about money already gone.
 */

export type SpendPeriod = 'day' | 'month'

/** One scope's limit and its spend so far this period. */
export interface ScopedSpend {
  readonly scope: 'workspace' | 'team'
  readonly period: SpendPeriod
  readonly periodStart: Date
  readonly spentCents: number
  readonly softLimitCents?: number
  readonly hardLimitCents?: number
}

export type SpendVerdict =
  | { readonly verdict: 'allow' }
  | {
      readonly verdict: 'soft' | 'hard'
      readonly scope: 'workspace' | 'team'
      readonly period: SpendPeriod
      readonly periodStart: Date
      readonly spentCents: number
      readonly projectedCents: number
      readonly limitCents: number
      /** Names the limit, its scope and the period, for the run's error. */
      readonly message: string
    }

/** The start of the current calendar period, in UTC. */
export function periodStart(period: SpendPeriod, now: Date): Date {
  return period === 'day'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/**
 * Hard before soft, and the tightest of each.
 *
 * Every scope binds (AC4): a team under its own limit inside a workspace over
 * its limit is refused. A hard limit outranks a soft one anywhere, because a
 * person approving a soft checkpoint cannot approve past a hard limit — asking
 * them would be asking a question whose answer is already no.
 */
export function evaluateSpendGuard(
  scopes: readonly ScopedSpend[],
  projectedCents: number,
): SpendVerdict {
  for (const level of ['hard', 'soft'] as const) {
    let tightest: { spend: ScopedSpend; limit: number; headroom: number } | undefined

    for (const spend of scopes) {
      const limit = level === 'hard' ? spend.hardLimitCents : spend.softLimitCents
      if (limit === undefined) continue
      if (spend.spentCents + projectedCents <= limit) continue

      const headroom = limit - spend.spentCents
      if (!tightest || headroom < tightest.headroom) tightest = { spend, limit, headroom }
    }

    if (tightest) {
      const { spend, limit } = tightest
      const start = spend.periodStart.toISOString().slice(0, 10)
      return {
        verdict: level,
        scope: spend.scope,
        period: spend.period,
        periodStart: spend.periodStart,
        spentCents: spend.spentCents,
        projectedCents,
        limitCents: limit,
        message:
          `The ${spend.scope} ${level} spend limit of ${limit}¢ for the ${spend.period} ` +
          `starting ${start} is reached: ${spend.spentCents}¢ spent, and this call is ` +
          `estimated at ${projectedCents}¢.`,
      }
    }
  }

  return { verdict: 'allow' }
}
