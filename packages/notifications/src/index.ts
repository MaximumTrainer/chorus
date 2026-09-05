import {
  defaultNotificationPreference,
  isNotificationKind,
  ulid,
  ValidationError,
  mayDisable,
  type MailTransport,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationKind,
  type NotificationPriority,
  type NotificationSink,
} from '@chorus/core'
import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Notification dispatch (SLACK-6).
 *
 * This package knows recipients, kinds, preferences and channels — and nothing
 * about what raised the event. That separation is the point of plan.md §2.1's
 * ordering: a dispatcher that knew what a checkpoint was would grow a branch
 * per event type, and the fourth one would be written by somebody who had
 * forgotten the preference check.
 *
 * Two properties everything here is built around:
 *
 * - **In-app delivery does not depend on the mail transport.** If SMTP is
 *   misconfigured — the ordinary state of a fresh self-hosted deployment — the
 *   inbox must still fill. A failed send is recorded as a failed *delivery*,
 *   never as a failed notification (AC6).
 * - **A gating notification cannot be silenced everywhere.** Muting the only
 *   channel does not mute the work: the run still waits, and nobody is coming.
 */

export interface NotificationRecord {
  readonly id: string
  readonly userId: string
  readonly kind: NotificationKind
  readonly priority: NotificationPriority
  readonly subject: string
  readonly body: string
  readonly targetType: string
  readonly targetId: string | null
  readonly payload: Record<string, unknown>
  /** Where to go to act on it, or null when there is nowhere in particular. */
  readonly path: string | null
  readonly readAt: string | null
  readonly createdAt: string
}

export interface Inbox {
  readonly unread: number
  readonly notifications: readonly NotificationRecord[]
}

export interface Notifier extends NotificationSink {
  /** Fans an event out to its recipients over every channel they allow. */
  notify(event: NotificationEvent): Promise<void>
  inbox(workspaceId: string, userId: string, limit?: number): Promise<Inbox>
  /** Idempotent: reading an already-read notification does not re-stamp it. */
  markRead(workspaceId: string, userId: string, notificationId: string): Promise<boolean>
  setPreference(input: {
    workspaceId: string
    userId: string
    kind: NotificationKind
    channel: NotificationChannel
    enabled: boolean
  }): Promise<void>
  /**
   * Deliveries that have not succeeded (AC6).
   *
   * An operator's view: it spans everyone in the workspace, which is why the
   * route that exposes it requires an administrative role.
   */
  failedDeliveries(workspaceId: string): Promise<readonly DeliveryFailure[]>
  /** Tries one failed delivery again. */
  retryDelivery(workspaceId: string, deliveryId: string): Promise<RetryOutcome>
  /** Whether this person has asked for their email to be batched (AC5). */
  digestSetting(workspaceId: string, userId: string): Promise<DigestSetting>
  setDigest(input: {
    workspaceId: string
    userId: string
    enabled: boolean
    cadenceMinutes?: number
  }): Promise<void>
  /**
   * Sends every waiting digest in a workspace, returning how many went out.
   *
   * Called on a schedule. Idempotent by construction: it collects deliveries
   * still `pending` and marks them `sent`, so a job delivered twice finds
   * nothing left the second time.
   */
  sendDigests(workspaceId: string): Promise<number>
}

export interface DigestSetting {
  readonly enabled: boolean
  readonly cadenceMinutes: number
  readonly lastSentAt: string | null
}

export interface NotifierOptions {
  readonly mail?: MailTransport
  /** Absolute base for links in email; a relative link in a mail client is dead. */
  readonly baseUrl: string
  readonly now?: () => Date
  /**
   * Asks for a failed delivery to be tried again later (AC6).
   *
   * A plain callback rather than a queue, so this package keeps its only
   * dependencies as `core` and `db`. The worker wires it to the real queue,
   * which is where backoff and attempt limits belong; a deployment that has
   * not wired it still records the failure, which is the visible half of AC6.
   */
  readonly scheduleRetry?: (input: {
    workspaceId: string
    deliveryId: string
    attempt: number
  }) => Promise<void>
  /** Attempts before a delivery is left failed for an operator. Default 5. */
  readonly maxAttempts?: number
}

/** A failed or pending delivery, with enough context to act on it. */
export interface DeliveryFailure {
  readonly id: string
  readonly notificationId: string
  readonly channel: NotificationChannel
  readonly status: string
  readonly attempts: number
  readonly lastError: string | null
  readonly kind: NotificationKind
  readonly subject: string
  readonly createdAt: string
}

/**
 * What came of a retry.
 *
 * Four outcomes rather than a boolean, because the caller has to tell "gave up
 * deliberately" from "still failing, try later" — and a boolean forced the
 * worker to ask a second question to find out, which is how two components
 * come to disagree about whether a delivery is finished.
 */
export type RetryOutcome =
  /** Delivered. */
  | 'sent'
  /** Failed again, and still worth another attempt. */
  | 'retry'
  /** Out of attempts. Left failed and visible, on purpose. */
  | 'exhausted'
  /** Nothing to do: already sent, suppressed, or not an email delivery. */
  | 'settled'

const DEFAULT_MAX_ATTEMPTS = 5

interface NotificationRow {
  id: string
  user_id: string
  kind: NotificationKind
  priority: NotificationPriority
  subject: string
  body: string
  target_type: string
  target_id: string | null
  payload: Record<string, unknown>
  path: string | null
  read_at: Date | null
  created_at: Date
}

const toRecord = (row: NotificationRow): NotificationRecord => ({
  id: row.id,
  userId: row.user_id,
  kind: row.kind,
  priority: row.priority,
  subject: row.subject,
  body: row.body,
  targetType: row.target_type,
  targetId: row.target_id,
  payload: row.payload,
  path: row.path,
  readAt: row.read_at ? row.read_at.toISOString() : null,
  createdAt: row.created_at.toISOString(),
})

export function createNotifier(config: DbConfig, options: NotifierOptions): Notifier {
  const now = options.now ?? (() => new Date())

  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>): Promise<T> =>
    withTenant(workspaceId, fn, { config })

  /** Whether this person wants this kind on this channel. */
  const wants = async (
    t: TenantTx,
    userId: string,
    kind: NotificationKind,
    channel: NotificationChannel,
  ): Promise<boolean> => {
    const [row] = await t.query<{ enabled: boolean }>(
      `SELECT enabled FROM notification_preferences
        WHERE user_id = $1 AND kind = $2 AND channel = $3`,
      [userId, kind, channel],
    )
    // No row means no expressed preference, and the default lives in code:
    // pre-populating a row per kind per user would need a backfill for every
    // new kind, and the missing row is exactly when someone stops being told.
    return row ? row.enabled : defaultNotificationPreference(kind, channel)
  }

  return {
    async notify(event) {
      if (!isNotificationKind(event.kind)) {
        throw new ValidationError(`Unknown notification kind "${event.kind}"`, { kind: event.kind })
      }

      for (const userId of event.recipients) {
        const { notificationId, sendEmail, address } = await tx(event.workspaceId, async (t) => {
          const inApp = await wants(t, userId, event.kind, 'in_app')
          const id = ulid()

          // The in-app row is written whether or not the person asked for it —
          // suppressed, not absent. An inbox with a hole in it cannot be
          // reconciled against a run's history later.
          await t.execute(
            `INSERT INTO notifications
               (id, workspace_id, user_id, kind, priority, subject, body, target_type,
                target_id, payload, path)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              id,
              event.workspaceId,
              userId,
              event.kind,
              event.priority ?? 'normal',
              event.subject,
              event.body ?? '',
              event.targetType,
              event.targetId ?? null,
              JSON.stringify(event.payload ?? {}),
              // Stored, not only rendered into the email. The in-app copy of a
              // notification that cannot say where to go tells somebody they
              // are wanted and not where.
              event.path ?? null,
            ],
          )

          await recordDelivery(t, event.workspaceId, id, 'in_app', inApp ? 'sent' : 'suppressed')

          const wantsEmail = await wants(t, userId, event.kind, 'email')
          if (!wantsEmail) {
            await recordDelivery(t, event.workspaceId, id, 'email', 'suppressed')
            return { notificationId: id, sendEmail: false, address: null }
          }

          // AC5. Urgent bypasses the digest, always: batching a gate would turn
          // a five-minute pause into a run stopped until tomorrow morning, for
          // somebody who asked for fewer emails and not for slower decisions.
          if ((event.priority ?? 'normal') !== 'urgent') {
            const [digest] = await t.query<{ enabled: boolean }>(
              `SELECT enabled FROM notification_digest_settings WHERE user_id = $1`,
              [userId],
            )
            if (digest?.enabled) {
              // Left `pending`, which is exactly what a deferred email is. The
              // digest then collects by querying that state rather than keeping
              // a second list that could disagree with it.
              await recordDelivery(t, event.workspaceId, id, 'email', 'pending')
              return { notificationId: id, sendEmail: false, address: null }
            }
          }

          const [user] = await t.query<{ email: string }>(
            `SELECT email FROM users WHERE id = $1`,
            [userId],
          )
          return { notificationId: id, sendEmail: true, address: user?.email ?? null }
        })

        if (!sendEmail) continue

        if (!address) {
          await tx(event.workspaceId, (t) =>
            recordDelivery(
              t,
              event.workspaceId,
              notificationId,
              'email',
              'failed',
              'no address on file',
            ),
          )
          continue
        }

        // Outside the transaction, deliberately: sending mail is a network call
        // and holding a database transaction open across one is how a slow
        // transport becomes a connection-pool outage.
        await deliverEmail(event, notificationId, address)
      }
    },

    async inbox(workspaceId, userId, limit = 50) {
      return tx(workspaceId, async (t) => {
        const rows = await t.query<NotificationRow>(
          `SELECT id, user_id, kind, priority, subject, body, target_type, target_id,
                  payload, path, read_at, created_at
             FROM notifications
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2`,
          [userId, limit],
        )
        const [count] = await t.query<{ unread: string }>(
          `SELECT count(*) AS unread FROM notifications
            WHERE user_id = $1 AND read_at IS NULL`,
          [userId],
        )
        return {
          // Counted over everything, not over the page: a badge that says 50
          // because that is the page size tells the reader nothing.
          unread: Number(count?.unread ?? 0),
          notifications: rows.map(toRecord),
        }
      })
    },

    async markRead(workspaceId, userId, notificationId) {
      return tx(workspaceId, async (t) => {
        // `read_at IS NULL` makes this idempotent: reading twice keeps the
        // first time rather than moving it, which matters because the read
        // time is what "consistent across tabs" is compared on.
        const rows = await t.query<{ id: string }>(
          `UPDATE notifications SET read_at = now()
            WHERE id = $1 AND user_id = $2 AND read_at IS NULL
            RETURNING id`,
          [notificationId, userId],
        )
        if (rows.length > 0) return true

        const [existing] = await t.query<{ id: string }>(
          `SELECT id FROM notifications WHERE id = $1 AND user_id = $2`,
          [notificationId, userId],
        )
        return existing !== undefined
      })
    },

    async digestSetting(workspaceId, userId) {
      const [row] = await tx(workspaceId, (t) =>
        t.query<{ enabled: boolean; cadence_minutes: number; last_sent_at: Date | null }>(
          `SELECT enabled, cadence_minutes, last_sent_at
             FROM notification_digest_settings WHERE user_id = $1`,
          [userId],
        ),
      )
      // Absence means off. Batching somebody's mail without them choosing it
      // changes when they hear about things.
      return {
        enabled: row?.enabled ?? false,
        cadenceMinutes: row?.cadence_minutes ?? 60,
        lastSentAt: row?.last_sent_at ? row.last_sent_at.toISOString() : null,
      }
    },

    async setDigest({ workspaceId, userId, enabled, cadenceMinutes }) {
      await tx(workspaceId, (t) =>
        t.execute(
          `INSERT INTO notification_digest_settings
             (id, workspace_id, user_id, enabled, cadence_minutes)
           VALUES ($1, $2, $3, $4, COALESCE($5, 60))
           ON CONFLICT (workspace_id, user_id) DO UPDATE
             SET enabled = EXCLUDED.enabled,
                 cadence_minutes = COALESCE($5, notification_digest_settings.cadence_minutes),
                 updated_at = now()`,
          [ulid(), workspaceId, userId, enabled, cadenceMinutes ?? null],
        ),
      )
    },

    async sendDigests(workspaceId) {
      // Everyone with something waiting. `pending` is exactly the state a
      // deferred email is left in, so the digest is a query rather than a
      // second bookkeeping system that could disagree with the first.
      const waiting = await tx(workspaceId, (t) =>
        t.query<{ user_id: string; email: string }>(
          `SELECT DISTINCT n.user_id, u.email
             FROM notification_deliveries d
             JOIN notifications n ON n.id = d.notification_id
             JOIN users u ON u.id = n.user_id
            WHERE d.channel = 'email' AND d.status = 'pending'`,
          [],
        ),
      )

      let sent = 0

      for (const person of waiting) {
        const items = await tx(workspaceId, (t) =>
          t.query<{ id: string; subject: string; body: string; created_at: Date }>(
            `SELECT d.id, n.subject, n.body, n.created_at
               FROM notification_deliveries d
               JOIN notifications n ON n.id = d.notification_id
              WHERE d.channel = 'email' AND d.status = 'pending' AND n.user_id = $1
              ORDER BY n.created_at`,
            [person.user_id],
          ),
        )

        // "You have no notifications" every morning is how a digest teaches
        // people to filter it.
        if (items.length === 0) continue

        // Each named, because a digest that says "you have 3 notifications"
        // makes the recipient open the app to find out whether any matter.
        const text = items
          .map((item) => `- ${item.subject}${item.body ? `\n  ${item.body}` : ''}`)
          .join('\n')
        const subject =
          items.length === 1
            ? `Chorus: ${items[0]!.subject}`
            : `Chorus: ${items.length} updates`

        if (!options.mail) {
          for (const item of items) {
            await tx(workspaceId, (t) =>
              bumpDelivery(t, item.id, 'failed', 'no mail transport is configured'),
            )
          }
          continue
        }

        try {
          await options.mail.send({
            to: person.email,
            subject,
            text: `${text}\n\n${options.baseUrl.replace(/\/$/, '')}/notifications\n`,
          })
          // Marked before the next person, and each item individually, so a
          // scheduled job delivered twice cannot send the same items again —
          // a digest is precisely the message people notice repeating.
          for (const item of items) {
            await tx(workspaceId, (t) => bumpDelivery(t, item.id, 'sent', null))
          }
          sent += 1
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          for (const item of items) {
            await tx(workspaceId, (t) => bumpDelivery(t, item.id, 'failed', message))
          }
        }

        await tx(workspaceId, (t) =>
          t.execute(
            `UPDATE notification_digest_settings SET last_sent_at = now() WHERE user_id = $1`,
            [person.user_id],
          ),
        )
      }

      return sent
    },

    async failedDeliveries(workspaceId) {
      return tx(workspaceId, async (t) => {
        const rows = await t.query<{
          id: string
          notification_id: string
          channel: NotificationChannel
          status: string
          attempts: number
          last_error: string | null
          kind: NotificationKind
          subject: string
          created_at: Date
        }>(
          `SELECT d.id, d.notification_id, d.channel, d.status, d.attempts, d.last_error,
                  n.kind, n.subject, d.created_at
             FROM notification_deliveries d
             JOIN notifications n ON n.id = d.notification_id
            WHERE d.status IN ('pending', 'failed')
            ORDER BY d.created_at DESC`,
          [],
        )
        return rows.map((row) => ({
          id: row.id,
          notificationId: row.notification_id,
          channel: row.channel,
          status: row.status,
          attempts: row.attempts,
          lastError: row.last_error,
          kind: row.kind,
          subject: row.subject,
          createdAt: row.created_at.toISOString(),
        }))
      })
    },

    async retryDelivery(workspaceId, deliveryId) {
      const context = await tx(workspaceId, async (t) => {
        const [row] = await t.query<{
          channel: NotificationChannel
          status: string
          attempts: number
          user_id: string
          subject: string
          body: string
        }>(
          `SELECT d.channel, d.status, d.attempts, n.user_id, n.subject, n.body
             FROM notification_deliveries d
             JOIN notifications n ON n.id = d.notification_id
            WHERE d.id = $1`,
          [deliveryId],
        )
        return row
      })

      // Nothing to do is not a failure: a queue retrying a delivery that
      // succeeded in the meantime is ordinary under at-least-once delivery.
      if (!context || context.status !== 'failed' || context.channel !== 'email') return 'settled'

      if (context.attempts >= (options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
        // Left failed, deliberately and visibly. Retrying forever would hide a
        // transport that is not coming back behind a queue that looks busy.
        return 'exhausted'
      }

      const [user] = await tx(workspaceId, (t) =>
        t.query<{ email: string }>(
          `SELECT u.email FROM users u
             JOIN notifications n ON n.user_id = u.id
             JOIN notification_deliveries d ON d.notification_id = n.id
            WHERE d.id = $1`,
          [deliveryId],
        ),
      )

      if (!options.mail || !user) {
        await tx(workspaceId, (t) =>
          bumpDelivery(t, deliveryId, 'failed', 'no mail transport or no address on file'),
        )
        // Not worth retrying: neither a missing transport nor a missing address
        // is going to change between one attempt and the next.
        return 'exhausted'
      }

      try {
        await options.mail.send({
          to: user.email,
          subject: context.subject,
          text: context.body || context.subject,
        })
        await tx(workspaceId, (t) => bumpDelivery(t, deliveryId, 'sent', null))
        return 'sent'
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await tx(workspaceId, (t) => bumpDelivery(t, deliveryId, 'failed', message))
        // Asked for again from here, so backoff and the attempt ceiling stay in
        // one place rather than being re-derived by every caller.
        await requestRetry(workspaceId, deliveryId, context.attempts + 1)
        return context.attempts + 1 >= (options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
          ? 'exhausted'
          : 'retry'
      }
    },

    async setPreference({ workspaceId, userId, kind, channel, enabled }) {
      if (!enabled && !mayDisable(kind, channel)) {
        throw new ValidationError(
          `${kind} cannot be turned off on ${channel}: a run waiting on this decision ` +
            `does not stop waiting because nobody was told. Choose a different channel instead.`,
          { kind, channel, required: true },
        )
      }

      await tx(workspaceId, (t) =>
        t.execute(
          `INSERT INTO notification_preferences
             (id, workspace_id, user_id, kind, channel, enabled)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (workspace_id, user_id, kind, channel) DO UPDATE
             SET enabled = EXCLUDED.enabled, updated_at = now()`,
          [ulid(), workspaceId, userId, kind, channel, enabled],
        ),
      )
    },
  }

  /** Records another attempt against an existing delivery row. */
  async function bumpDelivery(
    t: TenantTx,
    deliveryId: string,
    status: 'sent' | 'failed',
    error: string | null,
  ): Promise<void> {
    await t.execute(
      `UPDATE notification_deliveries
          SET status = $2, attempts = attempts + 1, last_error = $3,
              delivered_at = CASE WHEN $2 = 'sent' THEN now() ELSE delivered_at END
        WHERE id = $1`,
      [deliveryId, status, error],
    )
  }

  /**
   * Asks for another attempt, if anyone is listening.
   *
   * A deployment that has wired no scheduler still records the failure, which
   * is the visible half of AC6 — an operator can see it and act. Silently
   * doing nothing here is therefore a degradation, not a hole.
   */
  async function requestRetry(
    workspaceId: string,
    deliveryId: string,
    attempt: number,
  ): Promise<void> {
    if (!options.scheduleRetry) return
    if (attempt >= (options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) return
    await options.scheduleRetry({ workspaceId, deliveryId, attempt })
  }

  async function recordDelivery(
    t: TenantTx,
    workspaceId: string,
    notificationId: string,
    channel: NotificationChannel,
    status: 'pending' | 'sent' | 'failed' | 'suppressed',
    error?: string,
  ): Promise<string | undefined> {
    const attempted = status === 'sent' || status === 'failed'
    const rows = await t.query<{ id: string }>(
      `INSERT INTO notification_deliveries
         (id, workspace_id, notification_id, channel, status, attempts, last_error, delivered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (notification_id, channel) DO UPDATE
         SET status = EXCLUDED.status,
             attempts = notification_deliveries.attempts + EXCLUDED.attempts,
             last_error = EXCLUDED.last_error,
             delivered_at = EXCLUDED.delivered_at
       RETURNING id`,
      [
        ulid(),
        workspaceId,
        notificationId,
        channel,
        status,
        attempted ? 1 : 0,
        error ?? null,
        status === 'sent' ? now().toISOString() : null,
      ],
    )
    return rows[0]?.id
  }

  async function deliverEmail(
    event: NotificationEvent,
    notificationId: string,
    address: string,
  ): Promise<void> {
    if (!options.mail) {
      await tx(event.workspaceId, (t) =>
        recordDelivery(
          t,
          event.workspaceId,
          notificationId,
          'email',
          'failed',
          'no mail transport is configured',
        ),
      )
      return
    }

    const link = `${options.baseUrl.replace(/\/$/, '')}${event.path ?? '/'}`
    const text = `${event.body ?? event.subject}\n\n${link}\n`

    try {
      await options.mail.send({ to: address, subject: event.subject, text })
      await tx(event.workspaceId, (t) =>
        recordDelivery(t, event.workspaceId, notificationId, 'email', 'sent'),
      )
    } catch (error) {
      // AC6: the failure is recorded and visible, and the in-app notification
      // already exists — a broken transport must not swallow the event.
      const message = error instanceof Error ? error.message : String(error)
      const deliveryId = await tx(event.workspaceId, (t) =>
        recordDelivery(t, event.workspaceId, notificationId, 'email', 'failed', message),
      )
      // A transport is far more often briefly unavailable than permanently
      // broken, so the first failure asks for another attempt rather than
      // waiting for someone to notice.
      if (deliveryId) await requestRetry(event.workspaceId, deliveryId, 1)
    }
  }
}

export type {
  NotificationChannel,
  NotificationKind,
  NotificationPriority,
  NotificationEvent,
  NotificationSink,
  MailTransport,
} from '@chorus/core'
