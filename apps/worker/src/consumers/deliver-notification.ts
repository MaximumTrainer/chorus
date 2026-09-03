import type { Notifier } from '@chorus/notifications'
import type { Job } from '@chorus/queue'

/**
 * Retrying a notification delivery (SLACK-6 AC6).
 *
 * The first attempt happens inline, where the notification is created, because
 * a working transport should deliver immediately and not wait on a queue. This
 * consumer exists for the far more common case: a transport that was briefly
 * unavailable and has come back.
 *
 * **Backoff belongs to the queue, not here.** `consume` is registered with
 * attempts and a backoff, so this handler's only job is to make one attempt and
 * report honestly whether it worked — throwing when it did not, which is how a
 * queue is told to try again. A handler that swallowed the failure and returned
 * would look successful, and the delivery would sit failed forever with a queue
 * that believed it was done.
 *
 * **Idempotent** (CLAUDE.md §6.7). A duplicate delivery of the same job finds
 * the delivery already `sent` and does nothing — `retryDelivery` refuses
 * anything that is not still failed, so a redelivered job cannot send the same
 * mail twice.
 */

export const DELIVER_NOTIFICATION_QUEUE = 'notification.deliver'

export interface DeliverNotificationJob {
  readonly workspaceId: string
  readonly deliveryId: string
  /** Which attempt asked for this, recorded so a trace explains the sequence. */
  readonly attempt: number
}

export function deliverNotificationConsumer(deps: {
  notifier: Notifier
}): (job: Job<DeliverNotificationJob>) => Promise<void> {
  return async (job) => {
    const { workspaceId, deliveryId } = job.payload

    switch (await deps.notifier.retryDelivery(workspaceId, deliveryId)) {
      case 'sent':
        return

      case 'settled':
        // Already delivered, suppressed, or not an email at all. A duplicate
        // job landing here is ordinary under at-least-once delivery, and doing
        // nothing is exactly right — retrying would send the same mail twice.
        return

      case 'exhausted':
        // Given up on deliberately, and left visible to an operator. Throwing
        // would ask the queue to retry a decision that has been made.
        return

      case 'retry':
        // Still failing, still worth trying. Throwing hands the timing to the
        // queue's backoff, which is where delays and attempt limits are
        // configured — reimplementing them here would give a delivery two
        // ceilings that disagree.
        throw new Error(
          `Delivery ${deliveryId} was not sent; the queue will retry it with backoff.`,
        )
    }
  }
}
