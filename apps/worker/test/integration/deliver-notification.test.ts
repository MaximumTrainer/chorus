import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid, type MailTransport } from '@chorus/core'
import { createQueue, redisConfigFromEnv, type Queue } from '@chorus/queue'
import { createNotifier, type Notifier } from '@chorus/notifications'
import { createRecordingMailer, type RecordingMailer } from '@chorus/testing'
import {
  DELIVER_NOTIFICATION_QUEUE,
  deliverNotificationConsumer,
} from '../../src/consumers/deliver-notification.js'

/**
 * SLACK-6 AC6 — retry with backoff, against a real queue.
 *
 * The notifier's own tests prove what one retry does. This proves the part only
 * a queue can: that a failure asks for another attempt, that the attempt
 * actually happens, and that a transport which comes back gets the mail through
 * without anybody intervening.
 *
 * It also pins the thing most easily got wrong — that a delivery already sent
 * cannot be sent again by a redelivered job. At-least-once delivery makes that
 * ordinary rather than exotic (CLAUDE.md §6.7).
 */
describe('SLACK-6 AC6 notification delivery consumer', () => {
  let db: IsolatedDatabase
  let queue: Queue
  let mailer: RecordingMailer
  let workspaceId: string
  let userId: string

  /** Fails until told otherwise — a transport that is briefly unavailable. */
  let transportWorks: boolean

  const flaky: MailTransport = {
    send: async (message) => {
      if (!transportWorks) throw new Error('connect ECONNREFUSED 127.0.0.1:25')
      await mailer.send(message)
    },
  }

  const notifierWith = (extra: Parameters<typeof createNotifier>[1] | object = {}): Notifier =>
    createNotifier(db.config, {
      mail: flaky,
      baseUrl: 'https://chorus.example',
      ...(extra as object),
    } as Parameters<typeof createNotifier>[1])

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    queue = createQueue({ ...redisConfigFromEnv(), prefix: `test-${ulid()}` })
  }, 120_000)

  afterAll(async () => {
    await queue?.close()
    await db?.drop()
  })

  beforeEach(async () => {
    transportWorks = false
    mailer = createRecordingMailer()
    workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    const [member] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1`,
      [workspaceId],
    )
    userId = member!.user_id
    await db.admin.execute(`DELETE FROM notification_deliveries WHERE workspace_id = $1`, [
      workspaceId,
    ])
    await db.admin.execute(`DELETE FROM notifications WHERE workspace_id = $1`, [workspaceId])
  })

  const event = () => ({
    workspaceId,
    recipients: [userId],
    kind: 'checkpoint_requested' as const,
    subject: 'A run is waiting for your approval',
    body: 'It stopped at before_create_artefacts.',
    targetType: 'checkpoint',
    targetId: ulid(),
    path: '/somewhere',
  })

  it('SLACK-6 AC6: a failed delivery is enqueued, retried, and gets through when the transport returns', async () => {
    const notifier = notifierWith({
      scheduleRetry: async ({ workspaceId: ws, deliveryId, attempt }) => {
        await queue.enqueue(DELIVER_NOTIFICATION_QUEUE, {
          workspaceId: ws,
          deliveryId,
          attempt,
        })
      },
    })

    await notifier.notify(event())
    expect(await notifier.failedDeliveries(workspaceId)).toHaveLength(1)
    expect(mailer.sent, 'nothing can have been sent while the transport is down').toHaveLength(0)

    // The transport comes back before the worker picks the job up, which is
    // the case the whole retry path exists for.
    transportWorks = true
    await queue.consume(DELIVER_NOTIFICATION_QUEUE, deliverNotificationConsumer({ notifier }), {
      attempts: 3,
      backoffMs: 50,
    })
    await queue.drain(DELIVER_NOTIFICATION_QUEUE)

    expect(mailer.sent, 'the retry must actually send the mail').toHaveLength(1)
    expect(await notifier.failedDeliveries(workspaceId)).toEqual([])
    expect(await queue.failed(DELIVER_NOTIFICATION_QUEUE)).toEqual([])
  })

  it('SLACK-6 AC6: a delivery already sent is not sent again by a redelivered job', async () => {
    const notifier = notifierWith()
    transportWorks = true

    await notifier.notify(event())
    expect(mailer.sent).toHaveLength(1)

    const [delivery] = await db.admin.query<{ id: string }>(
      `SELECT id FROM notification_deliveries WHERE workspace_id = $1 AND channel = 'email'`,
      [workspaceId],
    )

    // The duplicate-delivery test CLAUDE.md §6.7 requires of every consumer.
    const handler = deliverNotificationConsumer({ notifier })
    const job = {
      id: 'j1',
      attempt: 1,
      payload: { workspaceId, deliveryId: delivery!.id, attempt: 1 },
      traceContext: undefined,
    }
    await handler(job as never)
    await handler(job as never)

    expect(mailer.sent, 'a redelivered job must not send the mail twice').toHaveLength(1)
  })

  it('SLACK-6 AC6: a transport that never returns leaves the failure visible, not a job spinning forever', async () => {
    const notifier = notifierWith({ maxAttempts: 2 })

    await notifier.notify(event())
    const [failure] = await notifier.failedDeliveries(workspaceId)

    await queue.enqueue(DELIVER_NOTIFICATION_QUEUE, {
      workspaceId,
      deliveryId: failure!.id,
      attempt: 1,
    })
    await queue.consume(DELIVER_NOTIFICATION_QUEUE, deliverNotificationConsumer({ notifier }), {
      attempts: 2,
      backoffMs: 50,
    })
    await queue.drain(DELIVER_NOTIFICATION_QUEUE)

    // Left failed and visible to an operator. The queue is not still trying:
    // a transport that is not coming back must not be hidden behind a busy
    // queue, which is the failure mode AC6's "visible" clause guards against.
    expect(await notifier.failedDeliveries(workspaceId)).toHaveLength(1)
    expect(mailer.sent).toHaveLength(0)
  })
})
