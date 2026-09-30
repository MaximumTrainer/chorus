import { describe, it, expect } from 'vitest'
import { evaluateSpendGuard, periodStart, type ScopedSpend } from './spend-guard.js'

/**
 * NFR-8 — the spend guard's decision, apart from where the numbers come from.
 *
 * Pure so that "does this call cross a limit" has one answer, stated once. The
 * executor reads the rows and the ledger; this decides.
 */
describe('NFR-8 spend guard decision', () => {
  const NOW = new Date('2026-09-15T12:34:56Z')

  const workspace = (over: Partial<ScopedSpend> = {}): ScopedSpend => ({
    scope: 'workspace',
    period: 'month',
    periodStart: periodStart('month', NOW),
    spentCents: 0,
    ...over,
  })

  it('NFR-8: a month starts at midnight UTC on the first, a day at midnight UTC', () => {
    expect(periodStart('month', NOW).toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(periodStart('day', NOW).toISOString()).toBe('2026-09-15T00:00:00.000Z')
  })

  it('NFR-8: with no limits there is nothing to decide', () => {
    expect(evaluateSpendGuard([], 1_000_000)).toEqual({ verdict: 'allow' })
  })

  it('NFR-8 AC1: the call is priced in, so a job that would cross the soft limit is caught before it runs', () => {
    const result = evaluateSpendGuard([workspace({ spentCents: 90, softLimitCents: 100 })], 11)
    expect(result).toMatchObject({
      verdict: 'soft',
      scope: 'workspace',
      spentCents: 90,
      projectedCents: 11,
      limitCents: 100,
    })
  })

  it('NFR-8 AC1: a job that lands exactly on the soft limit does not cross it', () => {
    expect(
      evaluateSpendGuard([workspace({ spentCents: 90, softLimitCents: 100 })], 10),
    ).toEqual({ verdict: 'allow' })
  })

  it('NFR-8 AC2: a hard limit that would be crossed refuses, and outranks a soft one', () => {
    const result = evaluateSpendGuard(
      [workspace({ spentCents: 90, softLimitCents: 50, hardLimitCents: 95 })],
      10,
    )
    expect(result).toMatchObject({ verdict: 'hard', limitCents: 95 })
  })

  it('NFR-8 AC2: the refusal names the limit, its scope and the period', () => {
    const result = evaluateSpendGuard([workspace({ spentCents: 150, hardLimitCents: 100 })], 3)
    expect(result.verdict).toBe('hard')
    if (result.verdict === 'allow') return
    expect(result.message).toBe(
      'The workspace hard spend limit of 100¢ for the month starting 2026-09-01 is reached: ' +
        '150¢ spent, and this call is estimated at 3¢.',
    )
  })

  it('NFR-8 AC4: the tighter of team and workspace binds, whichever it is', () => {
    const team: ScopedSpend = {
      scope: 'team',
      period: 'month',
      periodStart: periodStart('month', NOW),
      spentCents: 10,
      hardLimitCents: 1_000,
    }
    const overWorkspace = workspace({ spentCents: 150, hardLimitCents: 100 })

    expect(evaluateSpendGuard([team, overWorkspace], 1)).toMatchObject({
      verdict: 'hard',
      scope: 'workspace',
    })
    expect(
      evaluateSpendGuard([{ ...team, spentCents: 1_500 }, workspace({ hardLimitCents: 1_000_000 })], 1),
    ).toMatchObject({ verdict: 'hard', scope: 'team' })
  })
})
