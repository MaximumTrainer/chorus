import { ValidationError } from '@chorus/core'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'
import { isEntryPoint, type QuickAction, type SessionService } from './sessions.js'

/**
 * Session routes (CHAT-1).
 *
 * Starting a session is `member` — it is the everyday act, and the whole point
 * of three named doors is to lower the cost of beginning. Configuring the quick
 * actions is `admin`, because it decides how everybody on the team starts work.
 */
export function sessionRoutes(sessions: SessionService): RouteDefinition[] {
  return [
    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/teams/:teamId/sessions',
      summary: 'Start a session through one of the entry points.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
        if (!isEntryPoint(body.entryPoint)) {
          // Refused rather than defaulted: the door is the routing hint and
          // the record of how the session began, so guessing it would put a
          // wrong answer somewhere nobody thinks to check.
          throw new ValidationError('entryPoint must be one of the known doors', {
            field: 'entryPoint',
          })
        }

        const text = (field: string): string | undefined =>
          typeof body[field] === 'string' ? (body[field] as string) : undefined

        return c.json(
          await sessions.start({
            workspaceId: c.req.param('workspaceId'),
            teamId: c.req.param('teamId'),
            actorId: caller(c).userId,
            entryPoint: body.entryPoint,
            ...(text('seed') ? { seed: text('seed')! } : {}),
            ...(text('title') ? { title: text('title')! } : {}),
            ...(text('sourceType') ? { sourceType: text('sourceType')! } : {}),
            ...(text('sourceId') ? { sourceId: text('sourceId')! } : {}),
            ...(text('pastedText') ? { pastedText: text('pastedText')! } : {}),
            ...(text('quickActionKey') ? { quickActionKey: text('quickActionKey')! } : {}),
          }),
          201,
        )
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/sessions/:sessionId',
      summary: 'Read a session and its transcript.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(await sessions.get(c.req.param('workspaceId'), c.req.param('sessionId'))),
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/sessions/:sessionId/sources',
      summary: 'The artefacts a session was seeded from.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(await sessions.sources(c.req.param('workspaceId'), c.req.param('sessionId'))),
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/teams/:teamId/quick-actions',
      summary: 'The team’s configured starting moves.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(
          await sessions.quickActions(c.req.param('workspaceId'), c.req.param('teamId')),
        ),
    }),

    route({
      method: 'PUT',
      path: '/workspaces/:workspaceId/teams/:teamId/quick-actions',
      summary: 'Replace the team’s quick actions.',
      // Admin: this decides how everybody on the team starts work.
      auth: { kind: 'workspace', role: 'admin', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { actions?: unknown }
        if (!Array.isArray(body.actions)) {
          throw new ValidationError('actions must be an array', { field: 'actions' })
        }

        const actions: QuickAction[] = body.actions.map((raw) => {
          const action = raw as Record<string, unknown>
          const required = (field: string): string => {
            const value = action[field]
            if (typeof value !== 'string' || value.trim() === '') {
              throw new ValidationError(`each action needs a ${field}`, { field })
            }
            return value.trim()
          }
          const key = required('key')
          if (!/^[a-z][a-z0-9_]*$/.test(key)) {
            throw new ValidationError('an action key must be lower_snake_case', { field: 'key' })
          }
          return {
            key,
            label: required('label'),
            prompt: required('prompt'),
            hint: typeof action.hint === 'string' ? action.hint : null,
          }
        })

        return c.json(
          await sessions.putQuickActions({
            workspaceId: c.req.param('workspaceId'),
            teamId: c.req.param('teamId'),
            actorId: caller(c).userId,
            actions,
          }),
        )
      },
    }),
  ]
}
