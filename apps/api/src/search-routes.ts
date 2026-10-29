import { RETRIEVABLE_KINDS, SearchRequestSchema, ValidationError, type Retriever } from '@chorus/core'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'

/**
 * Retrieval over the API (BRAIN-4, architecture.md §10.5).
 *
 * The same `retrieve` the agents call, so MCP's `search`, global search and a
 * script get one ranking and one permission predicate. This route adds nothing
 * to what comes back. The predicate is inside the query, so what the caller
 * may not see is never a candidate, and `considered` cannot count it (AC2).
 * The bundle is persisted before it is returned, so every citation in it can
 * be resolved later through `GET /context-bundles/{id}` (AC4). And a query
 * that matches nothing is answered with an empty bundle (AC6).
 */

export function searchRoutes(retriever: Retriever): RouteDefinition[] {
  return [
    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/teams/:teamId/search',
      summary: 'Retrieve cited fragments for a question, filtered to what the caller may see.',
      // `read:brain`: what retrieval reads is the workspace's knowledge, which
      // is what that scope names (architecture.md §17), not the artefacts alone.
      auth: { kind: 'workspace', role: 'member', scopes: ['read:brain'] },
      handler: async (c) => {
        const parsed = SearchRequestSchema.safeParse(await c.req.json().catch(() => ({})))
        if (!parsed.success) {
          const issue = parsed.error.issues[0]
          const field = issue?.path.join('.') || 'body'
          throw new ValidationError(`${field}: ${issue?.message ?? 'invalid search'}`, { field })
        }

        const workspaceId = c.req.param('workspaceId')
        const bundle = await retriever.retrieve({
          query: parsed.data.query,
          workspaceId,
          teamId: c.req.param('teamId'),
          userId: caller(c).userId,
          // Every kind unless narrowed: this is the search a person or an agent
          // runs, not an agent's code-only grounding step.
          kinds: parsed.data.kinds ?? RETRIEVABLE_KINDS,
          ...(parsed.data.k !== undefined ? { k: parsed.data.k } : {}),
          ...(parsed.data.repositoryIds ? { filters: { repoIds: parsed.data.repositoryIds } } : {}),
        })
        await retriever.persist(workspaceId, bundle)
        return c.json(bundle)
      },
    }),
  ]
}
