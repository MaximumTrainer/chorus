import { createHash } from 'node:crypto'
import { Queue as BullQueue, Worker } from 'bullmq'
import IORedis from 'ioredis'

/**
 * The queue (ADR-0004, architecture.md §5.1).
 *
 * BullMQ on Redis, and **this is the only package that may import it**. ADR-0004
 * is explicit that "the engine's step interface must not leak BullMQ types",
 * because Temporal has to stay swappable while the step interface is still
 * cheap to re-implement (D-1, due end of Phase 1). A `Job` handed to a consumer
 * here therefore carries four fields and nothing else — asserted at runtime in
 * the integration suite, because a type-level promise disappears at runtime.
 *
 * At-least-once delivery is what a durable queue actually provides, so a
 * consumer being handed the same work twice is a **normal event**, not an
 * incident. CLAUDE.md §6.7 requires every consumer to be idempotent and to have
 * a duplicate-delivery test; `idempotencyKey` is the framework's half of that
 * bargain.
 */

export interface RedisConfig {
  readonly host: string
  readonly port: number
  readonly password?: string
  /** Namespaces every key, so two deployments — or two test runs — do not collide. */
  readonly prefix?: string
}

export function redisConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RedisConfig {
  return {
    host: env.CHORUS_REDIS_HOST ?? '127.0.0.1',
    port: Number(env.CHORUS_REDIS_PORT ?? 6379),
    ...(env.CHORUS_REDIS_PASSWORD ? { password: env.CHORUS_REDIS_PASSWORD } : {}),
  }
}

/** What a consumer is given. Deliberately four fields, and no backend types. */
export interface Job<T> {
  readonly id: string
  readonly name: string
  readonly payload: T
  /** 1 on the first delivery. A retry can behave differently knowing this. */
  readonly attempt: number
}

export type JobHandler<T> = (job: Job<T>) => Promise<void>

export interface EnqueueOptions {
  /**
   * Collapses repeat submissions of the same work.
   *
   * The framework's half of CLAUDE.md §6.7: a webhook redelivered, a source
   * retrying, an operator re-running a backfill. The consumer's half — being
   * idempotent against effects the queue cannot see — remains the consumer's.
   */
  readonly idempotencyKey?: string
  /** Milliseconds to wait before the job becomes available. */
  readonly delayMs?: number
}

export interface ConsumeOptions {
  /** Total attempts including the first. Defaults to 3. */
  readonly attempts?: number
  readonly backoffMs?: number
  /** Jobs handled in parallel by this consumer. */
  readonly concurrency?: number
}

export interface FailedJob {
  readonly id: string
  readonly reason: string
}

export interface Queue {
  enqueue<T>(name: string, payload: T, options?: EnqueueOptions): Promise<void>
  consume<T>(name: string, handler: JobHandler<T>, options?: ConsumeOptions): Promise<void>
  /**
   * Waits until this queue has nothing left to do.
   *
   * For tests and for graceful shutdown. Deliberately not a `sleep`: it awaits
   * an explicit condition, because a test that sleeps is a test that is either
   * slow or flaky and usually both (CLAUDE.md §5).
   */
  drain(name: string): Promise<void>
  /** Jobs that exhausted their attempts. "What failed, and why" must be answerable. */
  failed(name: string): Promise<FailedJob[]>
  close(): Promise<void>
}

const DEFAULT_ATTEMPTS = 3
const DEFAULT_BACKOFF_MS = 1_000

/**
 * Turns any string into something the backend will accept as a job id.
 *
 * BullMQ rejects a `:` in a custom id, and a natural idempotency key is
 * `${repositoryId}:${commitSha}` in this codebase and most others. Making
 * callers know that would be precisely the leak ADR-0004 forbids — the backend
 * dictating the shape of a caller's key — so it is hashed here. Collisions are
 * not a practical concern at 256 bits, and the hash is stable, which is the
 * only property deduplication needs.
 */
function jobIdFor(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32)
}

export function createQueue(config: RedisConfig): Queue {
  // Constructed here rather than passed as options: under native ESM BullMQ
  // cannot load its optional client itself, and an already-constructed one is
  // what it asks for. One connection, shared by every producer and consumer,
  // because a connection per queue name exhausts Redis on a worker that
  // subscribes to a dozen.
  const connection = new IORedis({
    host: config.host,
    port: config.port,
    ...(config.password ? { password: config.password } : {}),
    // Required by BullMQ's blocking commands.
    maxRetriesPerRequest: null,
  })
  const prefix = config.prefix ? `{chorus:${config.prefix}}` : '{chorus}'

  const producers = new Map<string, BullQueue>()
  const consumers = new Map<string, Worker>()
  /**
   * Retry policy per queue name.
   *
   * BullMQ attaches attempts and backoff to the *job*, but the consumer is what
   * knows whether its work is worth retrying — a connector sync is, a malformed
   * payload is not. So the consumer declares it and the producer applies it,
   * and a queue with no consumer registered yet gets the conservative default.
   */
  const policies = new Map<string, { attempts: number; backoffMs: number }>()

  const producerFor = (name: string): BullQueue => {
    const existing = producers.get(name)
    if (existing) return existing
    const created = new BullQueue(name, { connection, prefix })
    producers.set(name, created)
    return created
  }

  return {
    async enqueue(name, payload, options = {}) {
      const policy = policies.get(name) ?? {
        attempts: DEFAULT_ATTEMPTS,
        backoffMs: DEFAULT_BACKOFF_MS,
      }

      await producerFor(name).add(name, payload, {
        attempts: policy.attempts,
        backoff: { type: 'exponential', delay: policy.backoffMs },
        // BullMQ deduplicates on job id, so the idempotency key *is* the id.
        // Enqueuing the same key twice is then a no-op at the broker rather
        // than something every consumer has to defend against separately.
        ...(options.idempotencyKey ? { jobId: jobIdFor(options.idempotencyKey) } : {}),
        ...(options.delayMs ? { delay: options.delayMs } : {}),
        // Kept rather than removed: "which work failed and why" has to be
        // answerable, and a queue that discards its failures makes an outage
        // invisible until somebody notices missing data.
        removeOnComplete: { count: 100 },
        removeOnFail: false,
      })
    },

    async consume(name, handler, options = {}) {
      const worker = new Worker(
        name,
        async (job) => {
          // The four-field view. Nothing backend-shaped crosses this line.
          await handler({
            id: String(job.id),
            name: job.name,
            payload: job.data,
            attempt: job.attemptsMade + 1,
          })
        },
        {
          connection,
          prefix,
          concurrency: options.concurrency ?? 1,
        },
      )

      policies.set(name, {
        attempts: options.attempts ?? DEFAULT_ATTEMPTS,
        backoffMs: options.backoffMs ?? DEFAULT_BACKOFF_MS,
      })

      consumers.set(name, worker)
      await worker.waitUntilReady()
    },

    async drain(name) {
      const producer = producerFor(name)
      // An explicit condition, polled: waiting on counts is the only way to
      // know a queue is genuinely idle, and the alternative is a sleep long
      // enough to be slow and short enough to be flaky.
      for (let attempt = 0; attempt < 600; attempt++) {
        const counts = await producer.getJobCounts('active', 'waiting', 'delayed')
        const outstanding =
          (counts.active ?? 0) + (counts.waiting ?? 0) + (counts.delayed ?? 0)
        if (outstanding === 0) return
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error(`queue "${name}" did not drain`)
    },

    async failed(name) {
      const jobs = await producerFor(name).getFailed()
      return jobs.map((job) => ({ id: String(job.id), reason: job.failedReason ?? 'unknown' }))
    },

    async close() {
      await Promise.all([...consumers.values()].map((worker) => worker.close()))
      await Promise.all([...producers.values()].map((producer) => producer.close()))
      consumers.clear()
      producers.clear()
      connection.disconnect()
    },
  }
}
