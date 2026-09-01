import { describe, it, expect } from 'vitest'
import { contentHash, createInMemoryEmbeddingCache, cacheKey } from './cache.js'

/**
 * NFR-2 AC5 / NFR-8 — embeddings are content-hash cached.
 *
 * Re-syncing unchanged content must cost nothing (BRAIN-1 AC6). This is the
 * single largest lever on the running cost of the context engine, because
 * ingestion re-reads far more than it changes.
 */
describe('NFR-8 embedding cache', () => {
  it('NFR-8: identical content hashes identically', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'))
  })

  it('NFR-8: different content hashes differently', () => {
    expect(contentHash('hello')).not.toBe(contentHash('hello '))
  })

  it('NFR-8: the key includes the model, because embeddings are not portable between models', () => {
    expect(cacheKey('hello', 'model-a')).not.toBe(cacheKey('hello', 'model-b'))
  })

  it('NFR-8 AC5: a repeated embedding is served from cache', async () => {
    const cache = createInMemoryEmbeddingCache()
    let computed = 0
    const embed = async (text: string): Promise<number[]> => {
      computed += 1
      return [text.length]
    }

    const first = await cache.getOrCompute('hello', 'm', () => embed('hello'))
    const second = await cache.getOrCompute('hello', 'm', () => embed('hello'))

    expect(first).toEqual(second)
    expect(computed, 'the second call must not reach the provider').toBe(1)
  })

  it('NFR-8: a different model recomputes rather than returning the wrong vector', async () => {
    const cache = createInMemoryEmbeddingCache()
    let computed = 0
    const compute = async (): Promise<number[]> => {
      computed += 1
      return [computed]
    }

    await cache.getOrCompute('hello', 'model-a', compute)
    await cache.getOrCompute('hello', 'model-b', compute)

    expect(computed).toBe(2)
  })

  it('NFR-8: a failed computation is not cached, so a transient error is retried', async () => {
    const cache = createInMemoryEmbeddingCache()
    let attempts = 0
    const flaky = async (): Promise<number[]> => {
      attempts += 1
      if (attempts === 1) throw new Error('provider unavailable')
      return [1]
    }

    await expect(cache.getOrCompute('x', 'm', flaky)).rejects.toThrow('provider unavailable')
    await expect(cache.getOrCompute('x', 'm', flaky)).resolves.toEqual([1])
    expect(attempts).toBe(2)
  })

  it('NFR-8: concurrent requests for the same content compute once', async () => {
    const cache = createInMemoryEmbeddingCache()
    let computed = 0
    const slow = async (): Promise<number[]> => {
      computed += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return [1]
    }

    await Promise.all([
      cache.getOrCompute('x', 'm', slow),
      cache.getOrCompute('x', 'm', slow),
      cache.getOrCompute('x', 'm', slow),
    ])

    expect(computed, 'an in-flight computation must be shared, not duplicated').toBe(1)
  })

  it('NFR-8: hit and miss counts are observable, so the saving can be measured', async () => {
    const cache = createInMemoryEmbeddingCache()
    await cache.getOrCompute('x', 'm', async () => [1])
    await cache.getOrCompute('x', 'm', async () => [1])
    expect(cache.stats()).toEqual({ hits: 1, misses: 1 })
  })
})
