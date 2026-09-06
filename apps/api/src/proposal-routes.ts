import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'
import type { ProposalService } from './proposals.js'

/**
 * Structure proposal routes (CHAT-5).
 *
 * Proposing is `member` — it is what an agent turn does on somebody's behalf,
 * and a member may run a turn. Confirming is `member` too, deliberately: the
 * gate exists so that a *person* decides, and requiring an admin to accept
 * every task tree would make the gate an obstacle rather than a judgement, and
 * teach people to hand their work to whoever can click it away.
 */
export function proposalRoutes(proposals: ProposalService): RouteDefinition[] {
  return [
    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/sessions/:sessionId/proposals',
      summary: 'Record a proposed task tree, awaiting confirmation.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { tree?: unknown }
        const workspaceId = c.req.param('workspaceId')
        const sessionId = c.req.param('sessionId')
        return c.json(
          await proposals.propose({
            workspaceId,
            // The session decides the team, so a proposal cannot be attached to
            // one team's session and materialise onto another team's board.
            teamId: await proposals.teamForSession(workspaceId, sessionId),
            sessionId,
            tree: body.tree,
          }),
          201,
        )
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/proposals/:proposalId',
      summary: 'Read a proposal, its tree and its decision.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(await proposals.get(c.req.param('workspaceId'), c.req.param('proposalId'))),
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/proposals/:proposalId/confirm',
      summary: 'Confirm a proposal, materialising its tree into tasks.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { tree?: unknown }
        return c.json(
          await proposals.confirm({
            workspaceId: c.req.param('workspaceId'),
            proposalId: c.req.param('proposalId'),
            actorId: caller(c).userId,
            ...(body.tree === undefined ? {} : { tree: body.tree }),
          }),
        )
      },
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/proposals/:proposalId/reject',
      summary: 'Reject a proposal with feedback the next turn can read.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { feedback?: unknown }
        return c.json(
          await proposals.reject({
            workspaceId: c.req.param('workspaceId'),
            proposalId: c.req.param('proposalId'),
            actorId: caller(c).userId,
            feedback: typeof body.feedback === 'string' ? body.feedback : '',
          }),
        )
      },
    }),
  ]
}
