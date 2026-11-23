import { parseSpendLimit } from '@chorus/core'
import { route, type AppContext, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'
import type { SpendLimitService } from './spend-limits.js'

/**
 * Spend limit routes (WS-7 AC3).
 *
 * Reading is for every member: what the workspace may spend is something the
 * people spending it should be able to see. Setting is `admin`, as WS-7 names
 * it, and session-only: a limit is money, and a token lent to software that
 * could raise the hard limit would make the limit advisory.
 *
 * A PUT is a whole replacement, and a body that sets neither threshold removes
 * the limit — a limit that limits nothing is not one (migration 0038 refuses
 * such a row).
 */
export function spendLimitRoutes(limits: SpendLimitService): RouteDefinition[] {
  const replace = async (
    c: AppContext,
    teamId: string | null,
  ) => {
    const body: unknown = await c.req.json().catch(() => undefined)
    const limit = parseSpendLimit(body ?? {})
    const set = await limits.set({
      workspaceId: c.req.param('workspaceId'),
      actorId: caller(c).userId,
      teamId,
      limit,
    })
    return c.json(set)
  }

  return [
    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/spend-limits',
      summary: "The workspace's spend limit and each team's, with their periods.",
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) => c.json(await limits.list(c.req.param('workspaceId'))),
    }),

    route({
      method: 'PUT',
      path: '/workspaces/:workspaceId/spend-limit',
      summary: "Replace the workspace's spend limit, or remove it by setting neither threshold.",
      auth: { kind: 'workspace', role: 'admin', scopes: ['write:artefacts'], sessionOnly: true },
      handler: async (c) => replace(c, null),
    }),

    route({
      method: 'PUT',
      path: '/workspaces/:workspaceId/teams/:teamId/spend-limit',
      summary: "Replace one team's spend limit, or remove it by setting neither threshold.",
      auth: { kind: 'workspace', role: 'admin', scopes: ['write:artefacts'], sessionOnly: true },
      handler: async (c) => replace(c, c.req.param('teamId')),
    }),
  ]
}
