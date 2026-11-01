import { ValidationError } from '@chorus/core'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'
import type { InboxService, InboxKind } from './inbox.js'

/**
 * The review inbox routes (NAV-3).
 *
 * Reading is `member` with `read:artefacts` — everyone sees what needs the
 * team. Deciding is `member` with `write:artefacts`: resolving a conflict or a
 * brain proposal is everyday work, and each decision goes through the source's
 * own effect, so what the inbox can change is exactly what its reader could
 * change elsewhere.
 *
 * Mounted unconditionally so the permission suite covers them; the service is
 * always available (it only reads and dispatches).
 */

const KINDS: readonly string[] = ['checkpoint', 'sync_conflict', 'merge', 'split', 'stale', 'contradiction']

function parseKind(value: unknown): InboxKind {
  if (typeof value !== 'string' || !KINDS.includes(value)) {
    throw new ValidationError('unknown inbox item kind', { field: 'kind' })
  }
  return value as InboxKind
}

function parseDecision(value: unknown): 'accept' | 'reject' {
  if (value !== 'accept' && value !== 'reject') {
    throw new ValidationError('decision must be accept or reject', { field: 'decision' })
  }
  return value
}

export function inboxRoutes(inbox: InboxService): RouteDefinition[] {
  return [
    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/teams/:teamId/inbox',
      summary: 'The review inbox: everything blocking progress, grouped by kind with counts.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(
          await inbox.read({
            workspaceId: c.req.param('workspaceId'),
            teamId: c.req.param('teamId'),
          }),
        ),
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/teams/:teamId/inbox/decide',
      summary: 'Decide one inbox item in place; the effect occurs and it clears.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { kind?: unknown; id?: unknown; decision?: unknown }
        if (typeof body.id !== 'string' || body.id === '') {
          throw new ValidationError('id is required', { field: 'id' })
        }
        return c.json(
          await inbox.decide({
            workspaceId: c.req.param('workspaceId'),
            teamId: c.req.param('teamId'),
            kind: parseKind(body.kind),
            id: body.id,
            decision: parseDecision(body.decision),
            actorId: caller(c).userId,
          }),
        )
      },
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/teams/:teamId/inbox/bulk-decide',
      summary: 'Decide several low-risk items at once; per-item outcomes, high-risk kinds excluded.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { decisions?: unknown }
        if (!Array.isArray(body.decisions)) {
          throw new ValidationError('decisions must be an array', { field: 'decisions' })
        }
        const decisions = body.decisions.map((raw) => {
          const d = raw as { kind?: unknown; id?: unknown; decision?: unknown }
          if (typeof d.id !== 'string' || d.id === '') {
            throw new ValidationError('each decision needs an id', { field: 'id' })
          }
          return { kind: parseKind(d.kind), id: d.id, decision: parseDecision(d.decision) }
        })
        return c.json(
          await inbox.bulkDecide({
            workspaceId: c.req.param('workspaceId'),
            teamId: c.req.param('teamId'),
            decisions,
            actorId: caller(c).userId,
          }),
        )
      },
    }),
  ]
}
