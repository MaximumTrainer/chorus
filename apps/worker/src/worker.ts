import type { DbConfig } from '@chorus/db'
import type { Indexer } from '@chorus/indexer'
import type { Queue } from '@chorus/queue'
import {
  INDEX_REPOSITORY_QUEUE,
  indexRepositoryConsumer,
  type RepositoryAccess,
} from './consumers/index-repository.js'

/**
 * The worker process (architecture.md §6).
 *
 * BullMQ consumers, and nothing else. It holds no HTTP surface: everything it
 * does is enqueued by `api`, which is what lets queues be partitioned so a
 * heavy one gets its own replicas without touching the request path.
 *
 * Registration is a list rather than a scan of a directory. A consumer that
 * silently fails to register is a queue that fills forever with nobody reading
 * it, and a list is the only version of this that a reader can check.
 */

export interface WorkerDeps {
  readonly queue: Queue
  readonly dbConfig: DbConfig
  readonly indexer: Indexer
  readonly access: RepositoryAccess
}

export interface RunningWorker {
  /** Queue names this worker consumes, so a deployment can be checked against it. */
  readonly queues: readonly string[]
  stop(): Promise<void>
}

export async function createWorker(deps: WorkerDeps): Promise<RunningWorker> {
  await deps.queue.consume(
    INDEX_REPOSITORY_QUEUE,
    indexRepositoryConsumer({
      dbConfig: deps.dbConfig,
      indexer: deps.indexer,
      access: deps.access,
    }),
    // Indexing is long and I/O bound, and a transient clone failure is worth
    // retrying; a malformed job is not, which is why a missing repository
    // throws NotFoundError rather than something retried three times.
    { attempts: 3, backoffMs: 2_000, concurrency: 2 },
  )

  return {
    queues: [INDEX_REPOSITORY_QUEUE],
    async stop() {
      await deps.queue.close()
    },
  }
}
