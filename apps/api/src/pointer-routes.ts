import { ValidationError, isPointerSource } from '@chorus/core'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'
import type { PointerService } from './pointers.js'

/**
 * Code pointer routes (TASK-3).
 *
 * Generation takes the task's own title as the query by default: a pointer is
 * meant to answer "where in the code is this task about", and the title is what
 * the person actually wrote. A caller may pass a better query when it has one —
 * a shaping session knows more than a title does.
 */
export function pointerRoutes(pointers: PointerService): RouteDefinition[] {
  return [
    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/tasks/:taskId/pointers',
      summary: 'List a task’s code pointers, with deep links and confidence.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(await pointers.list(c.req.param('workspaceId'), c.req.param('taskId'))),
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/teams/:teamId/tasks/:taskId/pointers/generate',
      summary: 'Generate pointers from the index, replacing previously generated ones.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { query?: unknown }
        if (body.query !== undefined && typeof body.query !== 'string') {
          throw new ValidationError('query must be a string', { field: 'query' })
        }

        return c.json(
          await pointers.generate({
            workspaceId: c.req.param('workspaceId'),
            teamId: c.req.param('teamId'),
            taskId: c.req.param('taskId'),
            userId: caller(c).userId,
            query: body.query ?? '',
          }),
        )
      },
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/tasks/:taskId/pointers',
      summary: 'Add a pointer by hand, validated against the index.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
        const required = (field: string): string => {
          const value = body[field]
          if (typeof value !== 'string' || value.trim() === '') {
            throw new ValidationError(`${field} is required`, { field })
          }
          return value
        }
        const line = (field: string): number => {
          const value = body[field]
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
            throw new ValidationError(`${field} must be a line number`, { field })
          }
          return value
        }
        if (body.source !== undefined && !isPointerSource(body.source)) {
          throw new ValidationError('source must be generated, capture or manual', {
            field: 'source',
          })
        }

        return c.json(
          await pointers.addManual({
            workspaceId: c.req.param('workspaceId'),
            taskId: c.req.param('taskId'),
            userId: caller(c).userId,
            repositoryId: required('repositoryId'),
            path: required('path'),
            lineStart: line('lineStart'),
            lineEnd: line('lineEnd'),
            ...(typeof body.symbolName === 'string' ? { symbolName: body.symbolName } : {}),
          }),
          201,
        )
      },
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/tasks/:taskId/pointers/revalidate',
      summary: 'Re-check every pointer against the index, marking those that no longer resolve.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) =>
        c.json(await pointers.revalidate(c.req.param('workspaceId'), c.req.param('taskId'))),
    }),

    route({
      method: 'DELETE',
      path: '/workspaces/:workspaceId/pointers/:pointerId',
      summary: 'Remove a code pointer.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        await pointers.remove(c.req.param('workspaceId'), c.req.param('pointerId'))
        return c.body(null, 204)
      },
    }),
  ]
}
