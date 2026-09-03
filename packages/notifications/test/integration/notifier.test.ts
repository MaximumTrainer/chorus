import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid, ValidationError, type MailTransport } from '@chorus/core'
import { createRecordingMailer, type RecordingMailer } from '@chorus/testing'
import { createNotifier, type Notifier } from '../../src/index.js'

/**
 * SLACK-6 — dispatch, against a real database.
 *
 * The property worth the most here is AC6's, and it is the one a fresh
 * self-hosted deployment meets first: **SMTP is misconfigured**. If a broken
 * mail transport can swallow a checkpoint notification, the inbox — the only
 * surface that deployment has — is empty, and the run waits forever. So the
 * tests below break the transport on purpose and assert what survives.
 */
describe('SLACK-6 notification dispatch', () => {
  let db: IsolatedDatabase
  let mailer: RecordingMailer
  let notifier: Notifier

  /** A transport that always fails, standing in for a misconfigured one. */
  const broken: MailTransport = {
    send: async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:25')
    },
  }

  async function world(): Promise<{ workspaceId: string; userId: string; email: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    const [member] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1`,
      [workspaceId],
    )
    const [user] = await db.admin.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [
      member!.user_id,
    ])
    // The seed plants one of each row, this table included; left in place it
    // would make every count below quietly wrong.
    await db.admin.execute(`DELETE FROM notification_deliveries WHERE workspace_id = $1`, [
      workspaceId,
    ])
    await db.admin.execute(`DELETE FROM notification_preferences WHERE workspace_id = $1`, [
      workspaceId,
    ])
    await db.admin.execute(`DELETE FROM notifications WHERE workspace_id = $1`, [workspaceId])
    return { workspaceId, userId: member!.user_id, email: user!.email }
  }

  const event = (workspaceId: string, recipients: string[], overrides = {}) => ({
    workspaceId,
    recipients,
    kind: 'checkpoint_requested' as const,
    subject: 'A run is waiting for your approval',
    body: 'It stopped at before_create_artefacts.',
    targetType: 'checkpoint',
    targetId: ulid(),
    path: '/workspaces/x/checkpoints/y',
    ...overrides,
  })

  const deliveries = async (workspaceId: string) =>
    db.admin.query<{ channel: string; status: string; attempts: number; last_error: string | null }>(
      `SELECT channel, status, attempts, last_error FROM notification_deliveries
        WHERE workspace_id = $1 ORDER BY channel`,
      [workspaceId],
    )

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    mailer = createRecordingMailer()
    notifier = createNotifier(db.config, { mail: mailer, baseUrl: 'https://chorus.example' })
  })

  it('SLACK-6 AC1: an event reaches its recipient in-app and by email', async () => {
    const { workspaceId, userId, email } = await world()

    await notifier.notify(event(workspaceId, [userId]))

    const inbox = await notifier.inbox(workspaceId, userId)
    expect(inbox.unread).toBe(1)
    expect(inbox.notifications[0]).toMatchObject({ kind: 'checkpoint_requested', readAt: null })
    expect(mailer.to(email)).toHaveLength(1)

    // Both channels recorded, so "was this person told" is answerable per
    // channel rather than inferred from the absence of a complaint.
    expect(await deliveries(workspaceId)).toMatchObject([
      { channel: 'email', status: 'sent', attempts: 1 },
      { channel: 'in_app', status: 'sent' },
    ])
  })

  it('SLACK-6 AC1: the email carries an absolute link, because a relative one is dead in a mail client', async () => {
    const { workspaceId, userId, email } = await world()

    await notifier.notify(event(workspaceId, [userId]))

    expect(mailer.to(email)[0]!.verificationUrl).toBe(
      'https://chorus.example/workspaces/x/checkpoints/y',
    )
  })

  it('SLACK-6 AC6: a failing transport does not cost the in-app notification', async () => {
    const { workspaceId, userId } = await world()
    const failing = createNotifier(db.config, { mail: broken, baseUrl: 'https://chorus.example' })

    await failing.notify(event(workspaceId, [userId]))

    // The point of the whole requirement: with no chat surface and no working
    // mail, the inbox is what remains, and it must still fill.
    expect((await notifier.inbox(workspaceId, userId)).unread).toBe(1)

    const rows = await deliveries(workspaceId)
    const emailRow = rows.find((row) => row.channel === 'email')!
    expect(emailRow.status).toBe('failed')
    expect(emailRow.attempts).toBe(1)
    // Visible to an admin, and specific: "delivery failed" without the reason
    // sends someone to the logs of a process that may no longer exist.
    expect(emailRow.last_error).toContain('ECONNREFUSED')
    expect(rows.find((row) => row.channel === 'in_app')!.status).toBe('sent')
  })

  it('SLACK-6 AC6: a notifier with no transport at all records the gap rather than hiding it', async () => {
    const { workspaceId, userId } = await world()
    const silent = createNotifier(db.config, { baseUrl: 'https://chorus.example' })

    await silent.notify(event(workspaceId, [userId]))

    expect((await notifier.inbox(workspaceId, userId)).unread).toBe(1)
    expect(
      (await deliveries(workspaceId)).find((row) => row.channel === 'email')!.last_error,
    ).toMatch(/no mail transport/i)
  })

  it('SLACK-6 AC3: a disabled channel is recorded as suppressed, not silently absent', async () => {
    const { workspaceId, userId, email } = await world()
    await notifier.setPreference({
      workspaceId,
      userId,
      kind: 'checkpoint_requested',
      channel: 'email',
      enabled: false,
    })

    await notifier.notify(event(workspaceId, [userId]))

    expect(mailer.to(email)).toHaveLength(0)
    // Suppressed rather than missing: a delivery table with holes in it cannot
    // answer "why did I not get this", which is the question it exists for.
    expect(
      (await deliveries(workspaceId)).find((row) => row.channel === 'email')!.status,
    ).toBe('suppressed')
    expect((await notifier.inbox(workspaceId, userId)).unread).toBe(1)
  })

  it('SLACK-6 AC3: defaults differ per kind, and are not a blanket on or off', async () => {
    const { workspaceId, userId, email } = await world()

    // job_status defaults to in-app only; checkpoint_requested to both. A
    // single global default would make the preference model decorative.
    await notifier.notify(
      event(workspaceId, [userId], { kind: 'job_status', subject: 'A job finished' }),
    )

    expect(mailer.to(email)).toHaveLength(0)
    expect((await notifier.inbox(workspaceId, userId)).unread).toBe(1)
  })

  it('SLACK-6: a gating kind cannot be silenced on the one channel every deployment has', async () => {
    const { workspaceId, userId } = await world()

    await expect(
      notifier.setPreference({
        workspaceId,
        userId,
        kind: 'checkpoint_requested',
        channel: 'in_app',
        enabled: false,
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    // And the refusal changed nothing.
    await notifier.notify(event(workspaceId, [userId]))
    expect((await notifier.inbox(workspaceId, userId)).unread).toBe(1)
  })

  it('SLACK-6 AC4: reading is idempotent, so two tabs cannot disagree about when', async () => {
    const { workspaceId, userId } = await world()
    await notifier.notify(event(workspaceId, [userId]))
    const [first] = (await notifier.inbox(workspaceId, userId)).notifications

    expect(await notifier.markRead(workspaceId, userId, first!.id)).toBe(true)
    const afterFirst = (await notifier.inbox(workspaceId, userId)).notifications[0]!.readAt

    // The second tab, a moment later. It must find the notification and report
    // success — but must not move the time the first tab already showed.
    expect(await notifier.markRead(workspaceId, userId, first!.id)).toBe(true)
    expect((await notifier.inbox(workspaceId, userId)).notifications[0]!.readAt).toBe(afterFirst)
    expect((await notifier.inbox(workspaceId, userId)).unread).toBe(0)
  })

  it('SLACK-6: reading a notification that is not yours reports not-found', async () => {
    const { workspaceId, userId } = await world()
    await notifier.notify(event(workspaceId, [userId]))
    const [mine] = (await notifier.inbox(workspaceId, userId)).notifications

    const stranger = ulid()
    expect(await notifier.markRead(workspaceId, stranger, mine!.id)).toBe(false)
    expect((await notifier.inbox(workspaceId, userId)).unread).toBe(1)
  })

  it('SLACK-6 AC4: the unread count is over everything, not over the page', async () => {
    const { workspaceId, userId } = await world()
    for (let i = 0; i < 5; i += 1) {
      await notifier.notify(event(workspaceId, [userId], { subject: `Waiting ${i}` }))
    }

    const page = await notifier.inbox(workspaceId, userId, 2)
    expect(page.notifications).toHaveLength(2)
    // A badge that reads 2 because that is the page size tells the reader
    // nothing, and is worse than no badge.
    expect(page.unread).toBe(5)
    // Newest first: an inbox ordered the other way buries what just happened.
    expect(page.notifications[0]!.subject).toBe('Waiting 4')
  })

  it('SLACK-6: each recipient gets their own notification, not a shared one', async () => {
    const { workspaceId, userId } = await world()
    const [other] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND user_id <> $2 LIMIT 1`,
      [workspaceId, userId],
    )
    const second = other?.user_id

    await notifier.notify(event(workspaceId, second ? [userId, second] : [userId]))

    expect((await notifier.inbox(workspaceId, userId)).unread).toBe(1)
    if (second) {
      // Read state is per person: one reading it must not clear it for another.
      const [mine] = (await notifier.inbox(workspaceId, userId)).notifications
      await notifier.markRead(workspaceId, userId, mine!.id)
      expect((await notifier.inbox(workspaceId, second)).unread).toBe(1)
    }
  })

  it('SLACK-6 AC6: a failure asks for another attempt, because transports are usually briefly down', async () => {
    const { workspaceId, userId } = await world()
    const asked: Array<{ deliveryId: string; attempt: number }> = []
    const failing = createNotifier(db.config, {
      mail: broken,
      baseUrl: 'https://chorus.example',
      scheduleRetry: async ({ deliveryId, attempt }) => {
        asked.push({ deliveryId, attempt })
      },
    })

    await failing.notify(event(workspaceId, [userId]))

    expect(asked, 'the first failure must schedule a retry').toHaveLength(1)
    expect(asked[0]!.attempt).toBe(1)
    // Naming the delivery, not the notification: the in-app half succeeded and
    // must not be retried.
    const [failure] = await failing.failedDeliveries(workspaceId)
    expect(asked[0]!.deliveryId).toBe(failure!.id)
    expect(failure).toMatchObject({ channel: 'email', status: 'failed' })
  })

  it('SLACK-6 AC6: a retry that succeeds clears the failure', async () => {
    const { workspaceId, userId } = await world()
    let workingYet = false
    const flaky = createNotifier(db.config, {
      baseUrl: 'https://chorus.example',
      mail: {
        send: async (message) => {
          // The ordinary case: a transport that was down and came back.
          if (!workingYet) throw new Error('connect ECONNREFUSED 127.0.0.1:25')
          await mailer.send(message)
        },
      },
    })

    await flaky.notify(event(workspaceId, [userId]))
    const [failure] = await flaky.failedDeliveries(workspaceId)
    expect(failure).toBeDefined()

    workingYet = true
    expect(await flaky.retryDelivery(workspaceId, failure!.id)).toBe('sent')

    expect(await flaky.failedDeliveries(workspaceId)).toEqual([])
    const [row] = await db.admin.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM notification_deliveries WHERE id = $1`,
      [failure!.id],
    )
    // Two attempts recorded, not one: the count is what tells an operator
    // whether a transport is flapping or simply gone.
    expect(row).toMatchObject({ status: 'sent', attempts: 2 })
  })

  it('SLACK-6 AC6: retrying stops at the ceiling rather than forever', async () => {
    const { workspaceId, userId } = await world()
    const failing = createNotifier(db.config, {
      mail: broken,
      baseUrl: 'https://chorus.example',
      maxAttempts: 3,
    })

    await failing.notify(event(workspaceId, [userId]))
    const [failure] = await failing.failedDeliveries(workspaceId)

    // One more attempt is allowed, and it fails; the next reaches the ceiling.
    expect(await failing.retryDelivery(workspaceId, failure!.id)).toBe('retry')
    expect(await failing.retryDelivery(workspaceId, failure!.id)).toBe('exhausted')
    // Refused now, and still refused after: retrying forever would hide a
    // transport that is not coming back behind a queue that looks busy.
    expect(await failing.retryDelivery(workspaceId, failure!.id)).toBe('exhausted')

    const [row] = await db.admin.query<{ attempts: number; status: string }>(
      `SELECT attempts, status FROM notification_deliveries WHERE id = $1`,
      [failure!.id],
    )
    expect(row!.attempts).toBe(3)
    // Left failed and visible, which is what an operator needs.
    expect(row!.status).toBe('failed')
    expect(await failing.failedDeliveries(workspaceId)).toHaveLength(1)
  })

  it('SLACK-6 AC6: retrying a delivery that already succeeded does nothing', async () => {
    const { workspaceId, userId } = await world()
    await notifier.notify(event(workspaceId, [userId]))

    const [delivery] = await db.admin.query<{ id: string }>(
      `SELECT id FROM notification_deliveries WHERE workspace_id = $1 AND channel = 'email'`,
      [workspaceId],
    )

    // At-least-once delivery makes a duplicate retry job ordinary, not exotic.
    // Sending the mail a second time would be the failure here.
    expect(await notifier.retryDelivery(workspaceId, delivery!.id)).toBe('settled')
    expect(mailer.sent).toHaveLength(1)
  })

  it('SLACK-6 AC6: an unwired deployment still records the failure it cannot retry', async () => {
    const { workspaceId, userId } = await world()
    const unwired = createNotifier(db.config, { mail: broken, baseUrl: 'https://chorus.example' })

    // No scheduleRetry. Degraded, not broken: an operator can still see it,
    // which is the visible half of AC6 and the half that matters most.
    await unwired.notify(event(workspaceId, [userId]))
    expect(await unwired.failedDeliveries(workspaceId)).toHaveLength(1)
  })

  it('SLACK-6: an event with no recipients is a no-op, not an error', async () => {
    const { workspaceId, userId } = await world()

    // An event may legitimately concern nobody — an unassigned task, a team
    // with no members yet. Throwing would make callers guard every call.
    await expect(notifier.notify(event(workspaceId, []))).resolves.toBeUndefined()
    expect((await notifier.inbox(workspaceId, userId)).unread).toBe(0)
  })
})
