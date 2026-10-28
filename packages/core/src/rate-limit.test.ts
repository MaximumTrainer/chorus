import { describe, it, expect } from 'vitest'
import { takeToken, type BucketState } from './rate-limit.js'

const limit = { burst: 3, perMinute: 60 }

function drain(times: number, now = 0): BucketState | undefined {
  let state: BucketState | undefined
  for (let i = 0; i < times; i++) state = takeToken(limit, state, now).state
  return state
}

describe('MCP-5 AC4 token bucket', () => {
  it('MCP-5 AC4: allows the burst, then refuses with the wait until one call returns', () => {
    const state = drain(3)

    const refused = takeToken(limit, state, 0)

    expect(refused).toMatchObject({ allowed: false, retryAfterMs: 1000 })
  })

  it('MCP-5 AC4: refills continuously, never past the burst', () => {
    const state = drain(3)

    expect(takeToken(limit, state, 999).allowed).toBe(false)
    expect(takeToken(limit, state, 1000).allowed).toBe(true)
    // An hour idle is still only a burst's worth.
    let later = takeToken(limit, state, 3_600_000).state
    later = takeToken(limit, later, 3_600_000).state
    later = takeToken(limit, later, 3_600_000).state
    expect(takeToken(limit, later, 3_600_000).allowed).toBe(false)
  })

  it('MCP-5 AC4: the wait shrinks as the bucket refills', () => {
    const state = drain(3)

    expect(takeToken(limit, state, 400)).toMatchObject({ allowed: false, retryAfterMs: 600 })
  })
})
