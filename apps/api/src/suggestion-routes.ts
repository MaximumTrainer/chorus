import { ValidationError } from '@chorus/core'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'
import { isSuggestionDecision, type SuggestionService } from './suggestions.js'

/**
 * Suggested-edit routes (DOC-3).
 *
 * Asking for suggestions takes `write:artefacts` even though it writes nothing
 * to the document: it spends money on a model call against this workspace's
 * budget, and it produces something other people will be asked to decide on.
 * Read access would make "anyone who can see a document can queue work on it"
 * true, which is a different product.
 */
export function suggestionRoutes(suggestions: SuggestionService): RouteDefinition[] {
  const decisionFrom = (body: { decision?: unknown }) => {
    if (!isSuggestionDecision(body.decision)) {
      throw new ValidationError('decision must be "accept" or "reject"', { field: 'decision' })
    }
    return body.decision
  }

  const selectionFrom = (body: { from?: unknown; to?: unknown }) => {
    if (body.from === undefined && body.to === undefined) return undefined
    const from = Number(body.from)
    const to = Number(body.to)
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from) {
      // Refused rather than clamped. A selection nobody can make is a bug in
      // the caller, and silently widening it to the whole document is how an
      // instruction meant for one paragraph rewrites a page.
      throw new ValidationError('from and to must be a valid range within the document', {
        field: 'from',
      })
    }
    return { from, to }
  }

  return [
    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/documents/:documentId/suggestions',
      summary: 'Ask for suggested edits to a document or a selection within it.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as {
          instruction?: unknown
          from?: unknown
          to?: unknown
        }
        if (typeof body.instruction !== 'string' || body.instruction.trim() === '') {
          throw new ValidationError('instruction is required', { field: 'instruction' })
        }

        const selection = selectionFrom(body)
        return c.json(
          await suggestions.ask({
            workspaceId: c.req.param('workspaceId'),
            documentId: c.req.param('documentId'),
            userId: caller(c).userId,
            instruction: body.instruction.trim(),
            ...(selection ? { selection } : {}),
          }),
          201,
        )
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/documents/:documentId/suggestions',
      summary: 'List suggestion sets for a document, newest first.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(
          await suggestions.listFor(c.req.param('workspaceId'), c.req.param('documentId')),
        ),
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/suggestions/:suggestionId/decision',
      summary: 'Accept or reject one suggested edit.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { decision?: unknown }
        return c.json(
          await suggestions.decide({
            workspaceId: c.req.param('workspaceId'),
            suggestionId: c.req.param('suggestionId'),
            userId: caller(c).userId,
            decision: decisionFrom(body),
          }),
        )
      },
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/suggestion-sets/:setId/decision',
      summary: 'Accept or reject every suggestion still open in a set.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { decision?: unknown }
        return c.json(
          await suggestions.decideSet({
            workspaceId: c.req.param('workspaceId'),
            setId: c.req.param('setId'),
            userId: caller(c).userId,
            decision: decisionFrom(body),
          }),
        )
      },
    }),
  ]
}
