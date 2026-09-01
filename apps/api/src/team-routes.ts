import {
  ValidationError,
  ROLES,
  isCheckpointKind,
  isCheckpointMode,
  CHECKPOINT_KINDS,
  CHECKPOINT_MODES,
  type CheckpointKind,
  type CheckpointMode,
  type Role,
} from '@chorus/core'
import { route, type RouteDefinition } from './routes.js'
import { requireRole } from './authorisation.js'
import type { TeamService } from './teams.js'
import type { WorkspaceService } from './workspaces.js'

/**
 * Team routes (WS-3).
 *
 * Reading a team is a `member` action and changing one is an `admin` action:
 * the charter is context every member works from, but it is also injected into
 * every agent prompt, so editing it is a change to how the system behaves for
 * everyone. The same reasoning applies to a checkpoint policy — it decides
 * whether an autonomous step stops and asks — so a member must not be able to
 * open a gate that binds their colleagues.
 */

interface TeamBody {
  name?: unknown
  charter?: unknown
}

interface PolicyBody {
  workflowName?: unknown
  checkpointKind?: unknown
  mode?: unknown
  spendThresholdCents?: unknown
}

function parseCheckpointKind(value: unknown): CheckpointKind {
  if (!isCheckpointKind(value)) {
    throw new ValidationError(`checkpointKind must be one of: ${CHECKPOINT_KINDS.join(', ')}`, {
      field: 'checkpointKind',
    })
  }
  return value
}

function parseMode(value: unknown): CheckpointMode {
  if (!isCheckpointMode(value)) {
    throw new ValidationError(`mode must be one of: ${CHECKPOINT_MODES.join(', ')}`, {
      field: 'mode',
    })
  }
  return value
}

function parseRoleOverride(value: unknown): Role | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !(ROLES as readonly string[]).includes(value)) {
    throw new ValidationError(`roleOverride must be one of: ${ROLES.join(', ')}`, {
      field: 'roleOverride',
    })
  }
  return value as Role
}

async function body<T>(c: { req: { json(): Promise<unknown> } }): Promise<T> {
  return (await c.req.json().catch(() => ({}))) as T
}

export function teamRoutes(
  teams: TeamService,
  workspaces: WorkspaceService,
): RouteDefinition[] {
  return [
    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/teams',
      summary: 'Create a team.',
      auth: { kind: 'workspace', role: 'admin', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        const { userId } = await requireRole(c, workspaces, workspaceId, 'admin')
        const input = await body<TeamBody>(c)
        if (typeof input.name !== 'string') {
          throw new ValidationError('A team needs a name', { field: 'name' })
        }
        return c.json(
          await teams.create({
            workspaceId,
            actorId: userId,
            name: input.name,
            ...(input.charter === undefined ? {} : { charter: input.charter as string }),
          }),
          201,
        )
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/teams',
      summary: 'List the teams in a workspace.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        await requireRole(c, workspaces, workspaceId, 'member')
        return c.json(await teams.list(workspaceId))
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/teams/:teamId',
      summary: 'Read one team, including its charter.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        await requireRole(c, workspaces, workspaceId, 'member')
        return c.json(await teams.get(workspaceId, c.req.param('teamId')))
      },
    }),

    route({
      method: 'PATCH',
      path: '/workspaces/:workspaceId/teams/:teamId',
      summary: "Rename a team or edit its charter.",
      auth: { kind: 'workspace', role: 'admin', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        const { userId } = await requireRole(c, workspaces, workspaceId, 'admin')
        const input = await body<TeamBody>(c)
        return c.json(
          await teams.update({
            workspaceId,
            actorId: userId,
            teamId: c.req.param('teamId'),
            ...(input.name === undefined ? {} : { name: input.name as string }),
            ...(input.charter === undefined ? {} : { charter: input.charter as string }),
          }),
        )
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/teams/:teamId/members',
      summary: 'List the members of a team.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        await requireRole(c, workspaces, workspaceId, 'member')
        const teamId = c.req.param('teamId')
        // Establishes the team belongs to this workspace before listing, so a
        // foreign id yields not-found rather than an empty list that reads as
        // "this team has no members".
        await teams.get(workspaceId, teamId)
        return c.json(await teams.members(workspaceId, teamId))
      },
    }),

    route({
      method: 'PUT',
      path: '/workspaces/:workspaceId/teams/:teamId/members/:userId',
      summary: 'Add someone to a team, or set their role override in it.',
      auth: { kind: 'workspace', role: 'admin', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        const { userId: actorId } = await requireRole(c, workspaces, workspaceId, 'admin')
        const input = await body<{ roleOverride?: unknown }>(c)
        const roleOverride = parseRoleOverride(input.roleOverride)
        const teamId = c.req.param('teamId')

        await teams.addMember({
          workspaceId,
          actorId,
          teamId,
          userId: c.req.param('userId'),
          ...(roleOverride === undefined ? {} : { roleOverride }),
        })
        return c.json(await teams.members(workspaceId, teamId))
      },
    }),

    route({
      method: 'DELETE',
      path: '/workspaces/:workspaceId/teams/:teamId/members/:userId',
      summary: 'Remove someone from a team.',
      auth: { kind: 'workspace', role: 'admin', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        const { userId: actorId } = await requireRole(c, workspaces, workspaceId, 'admin')
        await teams.removeMember({
          workspaceId,
          actorId,
          teamId: c.req.param('teamId'),
          userId: c.req.param('userId'),
        })
        return c.body(null, 204)
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/teams/:teamId/policies',
      summary: 'The checkpoint policy in force for each kind, and which tier decided it.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        await requireRole(c, workspaces, workspaceId, 'member')
        const workflow = c.req.query('workflow')
        return c.json(
          await teams.resolvePolicies(
            workspaceId,
            c.req.param('teamId'),
            workflow === undefined ? undefined : workflow,
          ),
        )
      },
    }),

    route({
      method: 'PUT',
      path: '/workspaces/:workspaceId/teams/:teamId/policies',
      summary: "Set a team's checkpoint policy, overriding the workflow default.",
      auth: { kind: 'workspace', role: 'admin', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        const { userId } = await requireRole(c, workspaces, workspaceId, 'admin')
        const input = await body<PolicyBody>(c)
        const teamId = c.req.param('teamId')

        await teams.setPolicy({
          workspaceId,
          actorId: userId,
          teamId,
          checkpointKind: parseCheckpointKind(input.checkpointKind),
          mode: parseMode(input.mode),
          ...(typeof input.workflowName === 'string' ? { workflowName: input.workflowName } : {}),
          ...(typeof input.spendThresholdCents === 'number'
            ? { spendThresholdCents: input.spendThresholdCents }
            : {}),
        })

        const workflow = typeof input.workflowName === 'string' ? input.workflowName : undefined
        return c.json(await teams.resolvePolicies(workspaceId, teamId, workflow))
      },
    }),

    route({
      method: 'PUT',
      path: '/workspaces/:workspaceId/policies',
      summary: "Set a workflow's default checkpoint policy for every team.",
      auth: { kind: 'workspace', role: 'admin', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        const { userId } = await requireRole(c, workspaces, workspaceId, 'admin')
        const input = await body<PolicyBody>(c)

        // A workflow must be named. A policy scoped to neither a team nor a
        // workflow would be a single row opening every gate in the workspace,
        // which is not something to set in passing (architecture.md §11.5).
        if (typeof input.workflowName !== 'string' || !input.workflowName.trim()) {
          throw new ValidationError('A workflow default must name a workflow', {
            field: 'workflowName',
          })
        }

        await teams.setPolicy({
          workspaceId,
          actorId: userId,
          workflowName: input.workflowName,
          checkpointKind: parseCheckpointKind(input.checkpointKind),
          mode: parseMode(input.mode),
          ...(typeof input.spendThresholdCents === 'number'
            ? { spendThresholdCents: input.spendThresholdCents }
            : {}),
        })
        return c.json({ workflowName: input.workflowName, checkpointKind: input.checkpointKind })
      },
    }),
  ]
}
