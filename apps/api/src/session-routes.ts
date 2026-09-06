import { ValidationError } from '@chorus/core'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'
import { isEntryPoint, type QuickAction, type SessionService } from './sessions.js'
import { TurnFailed, type TurnEvent, type TurnRunner } from './chat-turn.js'
import { NotFoundError, type Retriever } from '@chorus/core'

/**
 * Session routes (CHAT-1).
 *
 * Starting a session is `member` — it is the everyday act, and the whole point
 * of three named doors is to lower the cost of beginning. Configuring the quick
 * actions is `admin`, because it decides how everybody on the team starts work.
 */
export function sessionRoutes(
  sessions: SessionService,
  turn?: TurnRunner,
  retriever?: Retriever,
): RouteDefinition[] {
  return [
    ...(retriever
      ? [
          route({
            method: 'GET',
            path: '/workspaces/:workspaceId/context-bundles/:bundleId',
            summary: 'The context a turn was grounded in — the “Context used” panel.',
            auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
            handler: async (c) => {
              // Read from the stored bundle, never re-retrieved. A panel that
              // ran retrieval again would agree with the turn almost always,
              // and disagree exactly when somebody is working out why an
              // answer was wrong — after the index moved on (CHAT-3 AC1).
              const bundle = await retriever.load(
                c.req.param('workspaceId'),
                c.req.param('bundleId'),
              )
              if (!bundle) {
                throw new NotFoundError('No such context bundle', {
                  bundleId: c.req.param('bundleId'),
                })
              }
              return c.json(bundle)
            },
          }),
        ]
      : []),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/sessions/:sessionId/messages',
      summary: 'Post a message and stream the agent’s turn.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { text?: unknown }
        if (typeof body.text !== 'string' || body.text.trim() === '') {
          throw new ValidationError('text is required', { field: 'text' })
        }
        if (!turn) {
          throw new ValidationError('this deployment cannot run turns', { field: 'turn' })
        }

        const workspaceId = c.req.param('workspaceId')
        const sessionId = c.req.param('sessionId')
        const actorId = caller(c).userId
        // Read before the stream opens, so an unknown session is a 404 with a
        // problem document rather than an error frame inside a 200.
        const session = await sessions.get(workspaceId, sessionId)

        // Recorded before the turn runs. If the model fails, what the person
        // typed is still there — losing their words because our provider broke
        // is the least forgivable outcome available here.
        await sessions.append({
          workspaceId,
          sessionId,
          role: 'user',
          content: { text: body.text },
          authorUserId: actorId,
        })

        const encoder = new TextEncoder()
        const stream = new ReadableStream({
          async start(controller) {
            let id = 0
            const send = (event: string, data: unknown): void => {
              // The id is per turn and monotonic, which is what makes
              // resumption possible at all (CHAT-2 AC4).
              controller.enqueue(
                encoder.encode(`id: ${++id}
event: ${event}
data: ${JSON.stringify(data)}

`),
              )
            }

            try {
              const result = await turn.run(
                { workspaceId, sessionId, teamId: session.teamId, actorId, text: body.text as string },
                (event: TurnEvent) => send(event.kind, event),
              )

              // Persisted before `done` is sent: a reader told the turn is
              // finished will reload, and a transcript that has not caught up
              // by then looks like the answer was lost.
              const message = await sessions.append({
                workspaceId,
                sessionId,
                role: 'assistant',
                content: { text: result.text },
                runId: result.runId,
                // The bundle's id, not a copy of its fragments: a copy is a
                // second version of the same fact, and the two disagree the
                // first time one is written and the other is not (CHAT-3 AC1).
                ...(result.bundleId ? { contextUsed: { bundleId: result.bundleId } } : {}),
              })

              send('message', message)
              send('done', { runId: result.runId })
            } catch (error) {
              // A stream that stops without saying why leaves a reader waiting
              // forever. The run id goes with it where there is one, so the
              // trace explaining the failure is reachable.
              send('error', {
                message: error instanceof Error ? error.message : String(error),
                ...(error instanceof TurnFailed ? { runId: error.runId } : {}),
              })
            } finally {
              controller.close()
            }
          },
        })

        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        })
      },
    }),

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
