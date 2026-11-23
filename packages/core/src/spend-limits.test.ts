import { describe, it, expect } from 'vitest'
import { MAX_SPEND_LIMIT_CENTS, parseSpendLimit } from './spend-limits.js'
import { ValidationError } from './errors.js'

describe('WS-7 spend limit input', () => {
  it('WS-7 AC3: a limit is a period with a soft and a hard threshold in whole cents', () => {
    expect(parseSpendLimit({ period: 'day', softLimitCents: 100, hardLimitCents: 200 })).toEqual({
      period: 'day',
      softLimitCents: 100,
      hardLimitCents: 200,
    })
  })

  it('WS-7 AC3: the period defaults to the month, and an omitted threshold is unset', () => {
    expect(parseSpendLimit({ hardLimitCents: 0 })).toEqual({
      period: 'month',
      softLimitCents: null,
      hardLimitCents: 0,
    })
  })

  it('WS-7: neither threshold set is a request to remove the limit, not a limit', () => {
    expect(parseSpendLimit({})).toBeNull()
    expect(parseSpendLimit({ softLimitCents: null, hardLimitCents: null })).toBeNull()
  })

  it('WS-7: refuses a threshold that is not a whole, non-negative number of cents, naming it', () => {
    for (const bad of [-1, 1.5, '100', Number.NaN, MAX_SPEND_LIMIT_CENTS + 1]) {
      expect(() => parseSpendLimit({ softLimitCents: bad }), String(bad)).toThrow(
        expect.objectContaining({ details: { field: 'softLimitCents' } }),
      )
      expect(() => parseSpendLimit({ hardLimitCents: bad }), String(bad)).toThrow(ValidationError)
    }
  })

  it('WS-7: refuses a period other than a day or a month', () => {
    expect(() => parseSpendLimit({ period: 'week', hardLimitCents: 1 })).toThrow(
      expect.objectContaining({ details: { field: 'period' } }),
    )
  })

  it('WS-7: refuses a soft limit above the hard one, which would never be asked about', () => {
    expect(() => parseSpendLimit({ softLimitCents: 200, hardLimitCents: 100 })).toThrow(
      expect.objectContaining({ details: { field: 'softLimitCents' } }),
    )
    expect(parseSpendLimit({ softLimitCents: 100, hardLimitCents: 100 })).not.toBeNull()
  })

  it('WS-7: refuses a body that is not an object', () => {
    expect(() => parseSpendLimit(null)).toThrow(ValidationError)
    expect(() => parseSpendLimit([])).toThrow(ValidationError)
  })
})
