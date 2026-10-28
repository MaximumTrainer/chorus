import type { BriefBuilder } from '@chorus/coding'
import { route, type RouteDefinition } from './routes.js'

/**
 * A task's coding brief (CODE-2, MCP-4 AC2).
 *
 * The one assembled for a sandbox, served as Markdown so an engineer's own
 * agent works from the same context. MCP's `implement-task` prompt is answered
 * by this route, which is what keeps the two byte-identical: there is one
 * builder and one call to it, not a second assembly that happens to agree.
 */
export function briefRoutes(briefs: BriefBuilder): RouteDefinition[] {
  return [
    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/tasks/:taskId/brief',
      summary: 'The coding brief for a task, as Markdown: what a sandbox is given.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) => {
        const markdown = await briefs.forMcpPrompt(c.req.param('workspaceId'), c.req.param('taskId'))
        c.header('content-type', 'text/markdown; charset=utf-8')
        return c.body(markdown)
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/tasks/:taskId/repo-context',
      summary: 'The repository, conventions, code pointers and routes a task will be worked in.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(await briefs.repoContext(c.req.param('workspaceId'), c.req.param('taskId'))),
    }),
  ]
}
