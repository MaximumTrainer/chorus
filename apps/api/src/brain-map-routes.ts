import type { BrainMap } from '@chorus/brain'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'

/**
 * The brain map (BRAIN-6), server half.
 *
 * `GET …/brain/map` returns the entity graph as nodes and edges, filtered by
 * the same per-signal permission predicate retrieval uses (AC6) — the map is
 * not an exemption from it. External-authority nodes carry their source so the
 * client can render "authoritative elsewhere" (BRAIN-11 AC7). Layout and
 * rendering are the client's; this sends no positions.
 *
 * `read:brain`, like search: what the map shows is the workspace's knowledge.
 * Mounted unconditionally so the permission suite covers it; it only reads.
 *
 * The caller's own permission scope ids are not yet resolved from their
 * memberships (identity-linking), so none are passed: a caller sees the
 * publicly-evidenced graph, the safe default, until that lands.
 */
export function brainMapRoutes(brainMap: BrainMap): RouteDefinition[] {
  return [
    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/brain/map',
      summary: 'The entity graph as permission-filtered nodes and edges, for the brain map.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:brain'] },
      handler: async (c) =>
        c.json(
          await brainMap.read({
            workspaceId: c.req.param('workspaceId'),
            userId: caller(c).userId,
          }),
        ),
    }),
  ]
}
