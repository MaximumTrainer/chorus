import { createHash } from 'node:crypto'

/**
 * Content-hash embedding cache (NFR-2 AC5, NFR-8 AC5).
 *
 * Ingestion re-reads far more than it changes, so a re-sync of unchanged
 * content must cost nothing (BRAIN-1 AC6). This is the largest single lever on
 * the running cost of the context engine.
 *
 * The in-memory implementation here is the interface's reference behaviour and
 * what tests run against; the production implementation is backed by the
 * `embedding_cache` table (architecture.md §8.3).
 */

export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Embeddings are not portable between models, so the model is part of the key.
 * Returning the wrong model's vector would corrupt retrieval silently, which is
 * far worse than a cache miss.
 */
export function cacheKey(text: string, model: string): string {
  return `${model}:${contentHash(text)}`
}

export interface EmbeddingCacheStats {
  readonly hits: number
  readonly misses: number
}

export interface EmbeddingCache {
  getOrCompute(text: string, model: string, compute: () => Promise<number[]>): Promise<number[]>
  stats(): EmbeddingCacheStats
}

export function createInMemoryEmbeddingCache(): EmbeddingCache {
  const entries = new Map<string, number[]>()
  /** In-flight computations, so concurrent callers share one provider call. */
  const inflight = new Map<string, Promise<number[]>>()
  let hits = 0
  let misses = 0

  return {
    async getOrCompute(text, model, compute) {
      const key = cacheKey(text, model)

      const cached = entries.get(key)
      if (cached) {
        hits += 1
        return cached
      }

      const pending = inflight.get(key)
      if (pending) {
        hits += 1
        return pending
      }

      misses += 1
      const promise = compute()
        .then((vector) => {
          entries.set(key, vector)
          return vector
        })
        .finally(() => {
          // A failed computation must not be cached: the next call should
          // retry rather than inherit a transient provider failure forever.
          inflight.delete(key)
        })

      inflight.set(key, promise)
      return promise
    },

    stats: () => ({ hits, misses }),
  }
}
