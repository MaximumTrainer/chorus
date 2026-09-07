import { contentHash } from '../cache.js'
import type { ModelRef } from '../types.js'

/**
 * Memoises token counts by `(model, content hash)` (NFR-8 AC6).
 *
 * Counting exists to make the spend guard a guard rather than a notification:
 * it runs *before* work, on prompts that share long stable prefixes with the
 * ones counted a moment ago. Paying a round trip for each would make the check
 * cost more than the call it protects.
 *
 * Keyed by model as well as content because tokenisers differ between models
 * and change with them — returning one model's count for another is the kind of
 * wrong that a budget silently absorbs.
 *
 * In-memory and unbounded per process, matching the embedding cache. A count is
 * tens of bytes and the working set is the set of prompts currently in flight;
 * if that ever stops being true it wants an eviction policy and a measurement
 * to justify it, not a guess now.
 */
export function createTokenCountCache(): {
  get(model: ModelRef, text: string, compute: () => Promise<number>): Promise<number>
} {
  const counts = new Map<string, Promise<number>>()

  return {
    async get(model, text, compute) {
      const key = `${model.provider}/${model.model}:${contentHash(text)}`
      // The promise is cached, not the value, so two concurrent counts of the
      // same text share one upstream call rather than racing to make two.
      const existing = counts.get(key)
      if (existing) return existing

      const pending = compute()
      counts.set(key, pending)
      try {
        return await pending
      } catch (error) {
        // A failed count must not be remembered as an answer.
        counts.delete(key)
        throw error
      }
    },
  }
}
