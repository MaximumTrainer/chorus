import { SCOPES, ValidationError, type Scope } from '@chorus/core'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'
import type { ApiTokenService } from './api-tokens.js'

/**
 * Personal API token routes (WS-5).
 *
 * All three are `sessionOnly`: a token may not manage tokens. Without that, an
 * admin's read-only token is not read-only — it can issue itself a wider one,
 * and the ceiling AC2 describes becomes a suggestion. The requirement is
 * declared as data like every other, so the permission suite enumerates it
 * rather than trusting this comment.
 *
 * They are `member` routes because a personal token is personal: everyone may
 * hold one, nobody may see or revoke anyone else's, and the service — not the
 * route — is what confines a caller to their own.
 */

function parseScopes(value: unknown): Scope[] {
  if (!Array.isArray(value)) {
    throw new ValidationError('A token must name the scopes it carries', { field: 'scopes' })
  }
  const unknown = value.filter((scope) => !(SCOPES as readonly string[]).includes(scope as string))
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown scope: ${unknown.join(', ')}`, {
      field: 'scopes',
      allowed: SCOPES,
    })
  }
  return value as Scope[]
}

export function apiTokenRoutes(tokens: ApiTokenService): RouteDefinition[] {
  return [
    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/tokens',
      summary: 'Create a personal API token. The plaintext is returned once.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'], sessionOnly: true },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        const { userId } = caller(c)
        const body = (await c.req.json().catch(() => ({}))) as {
          name?: unknown
          scopes?: unknown
          expiresInDays?: unknown
        }
        if (typeof body.name !== 'string') {
          throw new ValidationError('A token needs a name', { field: 'name' })
        }

        const issued = await tokens.create({
          workspaceId,
          userId,
          name: body.name,
          scopes: parseScopes(body.scopes),
          ...(typeof body.expiresInDays === 'number'
            ? { expiresInDays: body.expiresInDays }
            : {}),
        })

        // The only response that carries the plaintext, and the only time.
        return c.json(issued, 201)
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/tokens',
      summary: "List the caller's own personal API tokens, by prefix.",
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'], sessionOnly: true },
      handler: async (c) =>
        c.json(await tokens.listFor(c.req.param('workspaceId'), caller(c).userId)),
    }),

    route({
      method: 'DELETE',
      path: '/workspaces/:workspaceId/tokens/:tokenId',
      summary: 'Revoke a personal API token, with immediate effect.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'], sessionOnly: true },
      handler: async (c) => {
        await tokens.revoke(
          c.req.param('workspaceId'),
          caller(c).userId,
          c.req.param('tokenId'),
        )
        return c.body(null, 204)
      },
    }),
  ]
}
