import { ValidationError } from '@chorus/core'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'
import type { CommentService } from './comments.js'

/**
 * Comment routes (DOC-4).
 *
 * Commenting takes `member` and `write:artefacts`. It writes nothing to the
 * document, but it does put a question in front of colleagues and can notify
 * them — which is not something a read-only credential should be able to do.
 */
export function commentRoutes(comments: CommentService): RouteDefinition[] {
  const bodyOf = (input: { body?: unknown }): string => {
    if (typeof input.body !== 'string' || input.body.trim() === '') {
      throw new ValidationError('body is required', { field: 'body' })
    }
    return input.body.trim()
  }

  const mentionsOf = (input: { mentions?: unknown }): string[] => {
    if (input.mentions === undefined) return []
    if (!Array.isArray(input.mentions) || input.mentions.some((m) => typeof m !== 'string')) {
      throw new ValidationError('mentions must be an array of user ids', { field: 'mentions' })
    }
    return input.mentions as string[]
  }

  return [
    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/documents/:documentId/comments',
      summary: 'Start a comment thread anchored to a phrase in a document.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const input = (await c.req.json().catch(() => ({}))) as {
          quote?: unknown
          prefix?: unknown
          body?: unknown
          mentions?: unknown
        }
        if (typeof input.quote !== 'string' || input.quote === '') {
          throw new ValidationError('quote is required', { field: 'quote' })
        }

        return c.json(
          await comments.start({
            workspaceId: c.req.param('workspaceId'),
            documentId: c.req.param('documentId'),
            userId: caller(c).userId,
            quote: input.quote,
            ...(typeof input.prefix === 'string' && input.prefix !== ''
              ? { prefix: input.prefix }
              : {}),
            body: bodyOf(input),
            mentions: mentionsOf(input),
          }),
          201,
        )
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/documents/:documentId/comments',
      summary: 'List a document’s comment threads, orphans included.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(await comments.listFor(c.req.param('workspaceId'), c.req.param('documentId'))),
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/comment-threads/:threadId/replies',
      summary: 'Reply in a comment thread.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const input = (await c.req.json().catch(() => ({}))) as {
          body?: unknown
          mentions?: unknown
        }
        return c.json(
          await comments.reply({
            workspaceId: c.req.param('workspaceId'),
            threadId: c.req.param('threadId'),
            userId: caller(c).userId,
            body: bodyOf(input),
            mentions: mentionsOf(input),
          }),
          201,
        )
      },
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/comment-threads/:threadId/resolution',
      summary: 'Resolve a comment thread, or reopen it.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const input = (await c.req.json().catch(() => ({}))) as { resolved?: unknown }
        if (typeof input.resolved !== 'boolean') {
          throw new ValidationError('resolved must be true or false', { field: 'resolved' })
        }
        return c.json(
          await comments.setResolved({
            workspaceId: c.req.param('workspaceId'),
            threadId: c.req.param('threadId'),
            userId: caller(c).userId,
            resolved: input.resolved,
          }),
        )
      },
    }),
  ]
}
