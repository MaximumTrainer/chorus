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
}

export interface NotifierOptions {
  readonly mail?: MailTransport
  /** Absolute base for links in email; a relative link in a mail client is dead. */
  readonly baseUrl: string
  readonly now?: () => Date
}

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
                target_id, payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
            ],
          )

          await recordDelivery(t, event.workspaceId, id, 'in_app', inApp ? 'sent' : 'suppressed')

          const wantsEmail = await wants(t, userId, event.kind, 'email')
          if (!wantsEmail) {
            await recordDelivery(t, event.workspaceId, id, 'email', 'suppressed')
            return { notificationId: id, sendEmail: false, address: null }
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
                  payload, read_at, created_at
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

  async function recordDelivery(
    t: TenantTx,
    workspaceId: string,
    notificationId: string,
    channel: NotificationChannel,
    status: 'pending' | 'sent' | 'failed' | 'suppressed',
    error?: string,
  ): Promise<void> {
    const attempted = status === 'sent' || status === 'failed'
    await t.execute(
      `INSERT INTO notification_deliveries
         (id, workspace_id, notification_id, channel, status, attempts, last_error, delivered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (notification_id, channel) DO UPDATE
         SET status = EXCLUDED.status,
             attempts = notification_deliveries.attempts + EXCLUDED.attempts,
             last_error = EXCLUDED.last_error,
             delivered_at = EXCLUDED.delivered_at`,
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
      await tx(event.workspaceId, (t) =>
        recordDelivery(t, event.workspaceId, notificationId, 'email', 'failed', message),
      )
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
