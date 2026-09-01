import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
  ROLES,
  atLeast,
  type Role,
} from '@chorus/core'
import { route, type AppContext, type RouteDefinition } from './routes.js'
import type { WorkspaceService } from './workspaces.js'

/**
 * Workspace routes (WS-2).
 *
 * Every route declares the role it requires (WS-4 AC4). Membership-scoped
 * routes resolve the caller's role from the workspace in the path, and a
 * non-member is answered with not-found rather than forbidden: confirming that
 * a workspace exists would let anyone enumerate them by id (WS-2 AC4).
 */

function requireUser(c: AppContext): { id: string; email: string } {
  const user = c.get('user')
  if (!user) throw new UnauthenticatedError('Sign in to continue')
  return user
}

async function requireRole(
  c: AppContext,
  workspaces: WorkspaceService,
  workspaceId: string,
  minimum: Role,
): Promise<{ userId: string; role: Role }> {
  const user = requireUser(c)
  const role = await workspaces.roleOf(workspaceId, user.id)

  // Not a member: indistinguishable from a workspace that does not exist.
  if (!role) throw new NotFoundError('No such workspace', { workspaceId })

  if (!atLeast(role, minimum)) {
    throw new ForbiddenError(`This action requires the ${minimum} role`, {
      required: minimum,
      held: role,
    })
  }
  return { userId: user.id, role }
}

function parseRole(value: unknown): Role {
  if (typeof value !== 'string' || !(ROLES as readonly string[]).includes(value)) {
    throw new ValidationError(`Role must be one of: ${ROLES.join(', ')}`, { field: 'role' })
  }
  return value as Role
}

export function workspaceRoutes(workspaces: WorkspaceService): RouteDefinition[] {
  return [
    route({
      method: 'POST',
      path: '/workspaces',
      summary: 'Create a workspace, seeded with a default team.',
      // Any authenticated person may create their own workspace; there is no
      // membership to check because none exists yet.
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const user = requireUser(c)
        const body = (await c.req.json().catch(() => ({}))) as { name?: unknown }
        if (typeof body.name !== 'string') {
          throw new ValidationError('A workspace needs a name', { field: 'name' })
        }
        return c.json(await workspaces.create(user.id, body.name), 201)
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces',
      summary: 'List the workspaces the caller belongs to.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) => c.json(await workspaces.listFor(requireUser(c).id)),
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId',
      summary: 'Read one workspace.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) => {
        const user = requireUser(c)
        return c.json(await workspaces.get(c.req.param('workspaceId'), user.id))
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/members',
      summary: 'List members of a workspace.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        await requireRole(c, workspaces, workspaceId, 'member')
        return c.json(await workspaces.members(workspaceId))
      },
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/invitations',
      summary: 'Invite someone by email, or create a shareable invitation link.',
      auth: { kind: 'workspace', role: 'admin', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        const { userId } = await requireRole(c, workspaces, workspaceId, 'admin')

        const body = (await c.req.json().catch(() => ({}))) as {
          email?: unknown
          role?: unknown
          allowedDomain?: unknown
        }
        const role = parseRole(body.role)

        const invitation = await workspaces.invite({
          workspaceId,
          invitedBy: userId,
          role,
          ...(typeof body.email === 'string' ? { email: body.email } : {}),
          ...(typeof body.allowedDomain === 'string' ? { allowedDomain: body.allowedDomain } : {}),
        })

        const mailer = c.get('mailer')
        const baseUrl = c.get('baseUrl')
        if (typeof body.email === 'string' && mailer) {
          await mailer.send({
            to: body.email,
            subject: 'You have been invited to a Chorus workspace',
            text: `Accept the invitation:\n\n${baseUrl}/invitations/accept?token=${invitation.token}\n`,
          })
        }

        // The raw token is returned only to the inviter, and only for a link
        // invitation they must distribute themselves.
        return c.json(
          {
            id: invitation.id,
            expiresAt: invitation.expiresAt,
            ...(body.email ? {} : { token: invitation.token }),
          },
          201,
        )
      },
    }),

    route({
      method: 'POST',
      path: '/invitations/accept',
      summary: 'Accept an invitation.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const user = requireUser(c)
        const body = (await c.req.json().catch(() => ({}))) as { token?: unknown }
        if (typeof body.token !== 'string') {
          throw new ValidationError('An invitation token is required', { field: 'token' })
        }
        return c.json(await workspaces.acceptInvitation(body.token, user.id, user.email))
      },
    }),

    route({
      method: 'DELETE',
      path: '/workspaces/:workspaceId/members/:userId',
      summary: 'Remove a member from a workspace.',
      auth: { kind: 'workspace', role: 'admin', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        const { userId } = await requireRole(c, workspaces, workspaceId, 'admin')
        await workspaces.removeMember(workspaceId, userId, c.req.param('userId'))
        return c.body(null, 204)
      },
    }),

    route({
      method: 'PATCH',
      path: '/workspaces/:workspaceId/members/:userId',
      summary: "Change a member's role.",
      auth: { kind: 'workspace', role: 'admin', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        const { userId } = await requireRole(c, workspaces, workspaceId, 'admin')
        const body = (await c.req.json().catch(() => ({}))) as { role?: unknown }
        await workspaces.changeRole(workspaceId, userId, c.req.param('userId'), parseRole(body.role))
        return c.body(null, 204)
      },
    }),
  ]
}
