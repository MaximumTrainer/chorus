import { NotFoundError, ValidationError, isNotificationChannel, isNotificationKind } from '@chorus/core'
import type { Notifier } from '@chorus/notifications'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'

/**
 * The in-app inbox and per-user preferences (SLACK-6).
 *
 * Every route here is scoped to the caller and only the caller. A notification
 * is addressed to a person, not to a workspace, so there is deliberately no way
 * to read someone else's inbox — not even for an admin. An inbox others can
 * read is one people stop using for anything that matters.
 */
export function notificationRoutes(notifier: Notifier): RouteDefinition[] {
  return [
    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/notifications',
      summary: "Read the caller's own inbox and unread count.",
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) => {
        const limit = Number(c.req.query('limit') ?? 50)
        return c.json(
          await notifier.inbox(
            c.req.param('workspaceId'),
            caller(c).userId,
            Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50,
          ),
        )
      },
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/notifications/:notificationId/read',
      summary: 'Mark one of the caller’s notifications as read.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const found = await notifier.markRead(
          c.req.param('workspaceId'),
          caller(c).userId,
          c.req.param('notificationId'),
        )
        // Someone else's notification and one that never existed are alike from
        // here: neither is the caller's, and saying which would leak that a
        // notification exists.
        if (!found) {
          throw new NotFoundError('No such notification', {
            notificationId: c.req.param('notificationId'),
          })
        }
        return c.json({ ok: true })
      },
    }),

    route({
      method: 'PUT',
      path: '/workspaces/:workspaceId/notification-preferences',
      summary: 'Set whether the caller receives one kind of notification on one channel.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>

        if (!isNotificationKind(body.kind)) {
          throw new ValidationError('kind must be a known notification kind', { field: 'kind' })
        }
        if (!isNotificationChannel(body.channel)) {
          throw new ValidationError('channel must be in_app or email', { field: 'channel' })
        }
        if (typeof body.enabled !== 'boolean') {
          // Not coerced. A truthy string here would silently mean the opposite
          // of what the caller sent for `"false"`.
          throw new ValidationError('enabled must be true or false', { field: 'enabled' })
        }

        // The refusal for a gating kind lives in `core` and is raised by the
        // notifier, so the API and any settings screen cannot disagree about
        // what may be turned off.
        await notifier.setPreference({
          workspaceId: c.req.param('workspaceId'),
          userId: caller(c).userId,
          kind: body.kind,
          channel: body.channel,
          enabled: body.enabled,
        })

        return c.json({ kind: body.kind, channel: body.channel, enabled: body.enabled })
      },
    }),
  ]
}
