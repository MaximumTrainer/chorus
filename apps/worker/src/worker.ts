import type { DbConfig } from '@chorus/db'
import type { Notifier } from '@chorus/notifications'
import type { Indexer } from '@chorus/indexer'
import type { Job, Queue } from '@chorus/queue'
import { withRemoteContext, withSpan } from '@chorus/telemetry'
import {
  INDEX_REPOSITORY_QUEUE,
  indexRepositoryConsumer,
  type RepositoryAccess,
} from './consumers/index-repository.js'
import {
  DELIVER_NOTIFICATION_QUEUE,
  deliverNotificationConsumer,
} from './consumers/deliver-notification.js'

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
  /**
   * Notification delivery (SLACK-6 AC6).
   *
   * Optional: a deployment with no mail transport configured has nothing to
   * retry, and registering a consumer for a queue nobody fills would be a
   * worker that looks busier than it is.
   */
  readonly notifier?: Notifier
}

export interface RunningWorker {
  /** Queue names this worker consumes, so a deployment can be checked against it. */
  readonly queues: readonly string[]
  stop(): Promise<void>
}

/**
 * Wraps a consumer so its work joins the trace that enqueued it (NFR-5 AC2).
 *
 * Applied here rather than inside each consumer: a consumer that forgot would
 * produce an orphan trace, and "did you remember to wrap it" is not a property
 * anyone can check by reading. Registering through this function is.
 */
function traced<T extends { workspaceId?: string }>(
  queueName: string,
  handler: (job: Job<T>) => Promise<void>,
): (job: Job<T>) => Promise<void> {
  return (job) =>
    withRemoteContext(job.traceContext, () =>
      withSpan(
        `worker.${queueName}`,
        {
          'chorus.queue': queueName,
          'chorus.job.attempt': job.attempt,
          ...(job.payload.workspaceId ? { 'chorus.workspace_id': job.payload.workspaceId } : {}),
        },
        () => handler(job),
      ),
    )
}

export async function createWorker(deps: WorkerDeps): Promise<RunningWorker> {
  await deps.queue.consume(
    INDEX_REPOSITORY_QUEUE,
    traced(
      INDEX_REPOSITORY_QUEUE,
      indexRepositoryConsumer({
        dbConfig: deps.dbConfig,
        indexer: deps.indexer,
        access: deps.access,
      }),
    ),
    // Indexing is long and I/O bound, and a transient clone failure is worth
    // retrying; a malformed job is not, which is why a missing repository
    // throws NotFoundError rather than something retried three times.
    { attempts: 3, backoffMs: 2_000, concurrency: 2 },
  )

  if (deps.notifier) {
    const notifier = deps.notifier
    await deps.queue.consume(
      DELIVER_NOTIFICATION_QUEUE,
      traced(DELIVER_NOTIFICATION_QUEUE, deliverNotificationConsumer({ notifier })),
      // More attempts and a longer backoff than indexing, because the failure
      // being retried is usually a transport that is briefly unavailable, and
      // the cost of waiting is a late email rather than a stalled pipeline. The
      // ceiling here and the notifier's own must be read together: whichever is
      // reached first stops the retrying, and both leave the delivery visible.
      { attempts: 5, backoffMs: 5_000, concurrency: 4 },
    )
  }

  return {
    queues: deps.notifier
      ? [INDEX_REPOSITORY_QUEUE, DELIVER_NOTIFICATION_QUEUE]
      : [INDEX_REPOSITORY_QUEUE],
    async stop() {
      await deps.queue.close()
    },
  }
}
