import { ValidationError } from '@chorus/core'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'
import type { VersionService } from './versions.js'

/**
 * Version routes (DOC-5).
 *
 * Reading history takes `read:artefacts`; taking a snapshot, restoring and
 * pruning take `write:artefacts`, because each of them changes what the
 * document's history says — and pruning is the only one of the three that
 * removes anything, which is why it is a deliberate call rather than something
 * that happens on a read.
 */
export function versionRoutes(versions: VersionService): RouteDefinition[] {
  return [
    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/documents/:documentId/versions',
      summary: 'List a document’s versions, newest first.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(await versions.list(c.req.param('workspaceId'), c.req.param('documentId'))),
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/documents/:documentId/versions',
      summary: 'Take a named snapshot of a document as it stands.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { label?: unknown }
        return c.json(
          await versions.snapshot({
            workspaceId: c.req.param('workspaceId'),
            documentId: c.req.param('documentId'),
            userId: caller(c).userId,
            cause: 'manual',
            ...(typeof body.label === 'string' && body.label.trim() !== ''
              ? { label: body.label.trim() }
              : {}),
          }),
          201,
        )
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/documents/:documentId/versions/:fromId/diff/:toId',
      summary: 'Diff two versions of a document, block by block.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(
          await versions.diff(
            c.req.param('workspaceId'),
            c.req.param('fromId'),
            c.req.param('toId'),
          ),
        ),
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/documents/:documentId/versions/prune',
      summary: 'Apply a retention window, keeping approvals and restores.',
      // Admin: retention decides what history the team still has, which is a
      // different kind of decision from editing a document.
      auth: { kind: 'workspace', role: 'admin', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { keepDays?: unknown }
        const keepDays = Number(body.keepDays)
        if (!Number.isInteger(keepDays) || keepDays < 0) {
          throw new ValidationError('keepDays must be a whole number of days', {
            field: 'keepDays',
          })
        }
        return c.json({
          pruned: await versions.prune({
            workspaceId: c.req.param('workspaceId'),
            documentId: c.req.param('documentId'),
            keepDays,
          }),
        })
      },
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/documents/:documentId/versions/:versionId/restore',
      summary: 'Restore an earlier version as a new one, keeping all history.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { expectedUpdatedAt?: unknown }
        return c.json(
          await versions.restore({
            workspaceId: c.req.param('workspaceId'),
            documentId: c.req.param('documentId'),
            versionId: c.req.param('versionId'),
            userId: caller(c).userId,
            ...(typeof body.expectedUpdatedAt === 'string'
              ? { expectedUpdatedAt: body.expectedUpdatedAt }
              : {}),
          }),
        )
      },
    }),
  ]
}
