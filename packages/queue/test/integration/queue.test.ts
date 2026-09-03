import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ulid } from '@chorus/core'
import { createQueue, redisConfigFromEnv, type Queue } from '../../src/index.js'

/**
 * NFR-6, CLAUDE.md §6.7 — the queue, against a real Redis.
 *
 * Two guarantees, and the second is the one that costs work:
 *
 *  - **A job survives the process.** That is the whole reason for a queue; an
 *    in-memory one would pass every test here and lose everything on a restart.
 *  - **A consumer runs exactly once per job, even when the job is delivered
 *    twice.** At-least-once delivery is what every durable queue actually
 *    provides, so "handled twice" is a normal event, not an incident — and a
 *    consumer that is not idempotent turns a redelivery into a duplicate
 *    external write.
 *
 * A real Redis rather than a fake, because the redelivery behaviour under test
 * is the broker's, and a fake would only be testing my model of it.
 */
describe('NFR-6 queue', () => {
  let queue: Queue
  // Namespaced per run so parallel suites cannot consume each other's jobs.
  const prefix = `test-${ulid()}`

  beforeAll(() => {
    queue = createQueue({ ...redisConfigFromEnv(), prefix })
  })

  afterAll(async () => {
    await queue?.close()
  })

  beforeEach(() => {
    handled.length = 0
  })

  const handled: unknown[] = []

  it('NFR-6: an enqueued job reaches its consumer with its payload intact', async () => {
    const name = `reach-${ulid()}`
    await queue.consume<{ repositoryId: string }>(name, async (job) => {
      handled.push(job.payload)
    })

    await queue.enqueue(name, { repositoryId: 'repo-1' })
    await queue.drain(name)

    expect(handled).toEqual([{ repositoryId: 'repo-1' }])
  })

  it('CLAUDE.md §6.7: a job delivered twice is handled once', async () => {
    const name = `dedup-${ulid()}`
    await queue.consume<{ n: number }>(name, async (job) => {
      handled.push(job.payload)
    })

    // The same idempotency key twice. A source retrying, a webhook redelivered,
    // an operator re-running a backfill — all normal, all must not double.
    await queue.enqueue(name, { n: 1 }, { idempotencyKey: 'the-same-work' })
    await queue.enqueue(name, { n: 1 }, { idempotencyKey: 'the-same-work' })
    await queue.drain(name)

    expect(handled).toHaveLength(1)
  })

  it('CLAUDE.md §6.7: any string works as an idempotency key', async () => {
    const name = `keyshape-${ulid()}`
    await queue.consume(name, async (job) => {
      handled.push(job.payload)
    })

    // The natural key in this codebase is `${repositoryId}:${commitSha}`, and
    // the backend rejects a colon in a job id. A caller having to know that
    // would be exactly the leak ADR-0004 forbids.
    const awkward = 'repo-01ARZ3:abcdef/with spaces#and-hash'
    await queue.enqueue(name, { n: 1 }, { idempotencyKey: awkward })
    await queue.enqueue(name, { n: 1 }, { idempotencyKey: awkward })
    await queue.drain(name)

    expect(handled).toHaveLength(1)
  })

  it('CLAUDE.md §6.7: different work with different keys is not collapsed', async () => {
    const name = `distinct-${ulid()}`
    await queue.consume<{ n: number }>(name, async (job) => {
      handled.push(job.payload)
    })

    await queue.enqueue(name, { n: 1 }, { idempotencyKey: 'a' })
    await queue.enqueue(name, { n: 2 }, { idempotencyKey: 'b' })
    await queue.drain(name)

    expect(handled).toHaveLength(2)
  })

  it('NFR-6: a failing job is retried, and succeeds on a later attempt', async () => {
    const name = `retry-${ulid()}`
    let attempts = 0
    await queue.consume<{ n: number }>(
      name,
      async (job) => {
        attempts += 1
        if (attempts < 3) throw new Error('transient')
        handled.push(job.payload)
      },
      { attempts: 3, backoffMs: 1 },
    )

    await queue.enqueue(name, { n: 1 })
    await queue.drain(name)

    // A transient provider failure must not lose the work. Retries with backoff
    // are the difference between a sync that recovers and one that needs a
    // human.
    expect(attempts).toBe(3)
    expect(handled).toHaveLength(1)
  })

  it('NFR-6: a job that exhausts its attempts is kept, not silently dropped', async () => {
    const name = `dead-${ulid()}`
    await queue.consume(
      name,
      async () => {
        throw new Error('permanently broken')
      },
      { attempts: 2, backoffMs: 1 },
    )

    await queue.enqueue(name, { n: 1 })
    await queue.drain(name)

    // "Which work failed and why" has to be answerable. A queue that discards
    // its failures makes an outage invisible until somebody notices missing
    // data.
    const failures = await queue.failed(name)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.reason).toMatch(/permanently broken/)
  })

  it('NFR-6: the handler receives the attempt number, so a retry can behave differently', async () => {
    const name = `attempt-${ulid()}`
    const seen: number[] = []
    await queue.consume(
      name,
      async (job) => {
        seen.push(job.attempt)
        if (job.attempt < 2) throw new Error('again')
      },
      { attempts: 2, backoffMs: 1 },
    )

    await queue.enqueue(name, {})
    await queue.drain(name)

    expect(seen).toEqual([1, 2])
  })

  it('NFR-6: work is partitioned by queue name, so one queue cannot starve another', async () => {
    const heavy = `heavy-${ulid()}`
    const light = `light-${ulid()}`
    const order: string[] = []

    await queue.consume(heavy, async () => {
      order.push('heavy')
    })
    await queue.consume(light, async () => {
      order.push('light')
    })

    await queue.enqueue(heavy, {})
    await queue.enqueue(light, {})
    await queue.drain(heavy)
    await queue.drain(light)

    expect(order.sort()).toEqual(['heavy', 'light'])
  })

  it('NFR-5 AC2: trace context is carried across the queue, unchanged', async () => {
    const name = `trace-${ulid()}`
    let received: Readonly<Record<string, string>> | undefined
    await queue.consume(name, async (job) => {
      received = job.traceContext
    })

    // A trace is process-local ambient state; a queue is a boundary it does not
    // cross by itself. Carried explicitly, or a run appears as two unrelated
    // traces and "where did this request's work go" has no answer.
    const carrier = { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }
    await queue.enqueue(name, { n: 1 }, { traceContext: carrier })
    await queue.drain(name)

    expect(received).toEqual(carrier)
  })

  it('NFR-5 AC2: the payload is exactly what was sent, with no carried metadata in it', async () => {
    const name = `envelope-${ulid()}`
    let payload: unknown
    await queue.consume(name, async (job) => {
      payload = job.payload
    })

    await queue.enqueue(
      name,
      { repositoryId: 'repo-1' },
      { traceContext: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' } },
    )
    await queue.drain(name)

    // Enveloped, not merged: a `_trace` key inside the payload would eventually
    // be read as data by something.
    expect(payload).toEqual({ repositoryId: 'repo-1' })
  })

  it('NFR-6: nothing in the public surface names BullMQ', async () => {
    // ADR-0004: "the engine's step interface must not leak BullMQ types", so
    // Temporal stays swappable. Asserted on the value a caller actually holds,
    // because a type-level promise disappears at runtime.
    const name = `opaque-${ulid()}`
    let received: unknown
    await queue.consume(name, async (job) => {
      received = job
    })
    await queue.enqueue(name, { a: 1 })
    await queue.drain(name)

    // `traceContext` is absent when none was carried, so the shape stays
    // minimal for a caller that does not trace.
    expect(Object.keys(received as object).sort()).toEqual(['attempt', 'id', 'name', 'payload'])
  })
})
