/**
 * A token bucket (MCP-5 AC4).
 *
 * `burst` calls may be made at once, and the bucket refills continuously at
 * `perMinute`. A bucket rather than a fixed window, because a window lets a
 * client make twice the limit across its boundary, and an agent in a loop
 * finds that boundary.
 *
 * Pure: the caller supplies the time and keeps the state, so the rule is
 * tested without a clock and without a store.
 */

export interface RateLimit {
  readonly burst: number
  readonly perMinute: number
}

export interface BucketState {
  readonly tokens: number
  readonly at: number
}

export type TakeResult =
  | { readonly allowed: true; readonly state: BucketState }
  | { readonly allowed: false; readonly state: BucketState; readonly retryAfterMs: number }

/** Takes one call from a bucket, or says how long until one is available. */
export function takeToken(limit: RateLimit, state: BucketState | undefined, now: number): TakeResult {
  const perMs = limit.perMinute / 60_000
  const previous = state ?? { tokens: limit.burst, at: now }
  const tokens = Math.min(limit.burst, previous.tokens + Math.max(0, now - previous.at) * perMs)

  if (tokens >= 1) return { allowed: true, state: { tokens: tokens - 1, at: now } }
  return {
    allowed: false,
    state: { tokens, at: now },
    retryAfterMs: Math.ceil((1 - tokens) / perMs),
  }
}
