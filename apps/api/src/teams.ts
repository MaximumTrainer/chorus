import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  CHECKPOINT_KINDS,
  resolveCheckpointPolicy,
  resolveRole,
  uniqueSlug,
  ulid,
  type CheckpointKind,
  type CheckpointMode,
  type PolicyRule,
  type ResolvedPolicy,
  type Role,
} from '@chorus/core'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Teams, charters, membership overrides and checkpoint policies (WS-3).
 *
 * A team is the boundary at which charter, repositories, trackers and default
 * policies differ. It is deliberately *not* a second tenancy boundary: RLS
 * keys on `workspace_id`, and team scoping is an ordinary predicate plus a
 * membership check. Making it a second boundary would double the surface on
 * which isolation can be got wrong, for no security the workspace does not
 * already provide.
 */

/** Matches the database check constraint. The charter is prompt input, so it is bounded. */
export const MAX_CHARTER_LENGTH = 8000

/**
 * How many times a slug collision is retried before the caller is told.
 *
 * Each retry re-reads the taken slugs, so it converges: an attempt only loses
 * to a create that committed in the window, and each one that commits takes a
 * suffix out of contention.
 */
const SLUG_ATTEMPTS = 5

export interface TeamRecord {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly charter: string
}

export interface TeamMemberRecord {
  readonly userId: string
  readonly teamId: string
  readonly roleOverride: Role | null
}

export interface TeamService {
  create(input: {
    workspaceId: string
    actorId: string
    name: string
    charter?: string
  }): Promise<TeamRecord>
  list(workspaceId: string): Promise<TeamRecord[]>
  get(workspaceId: string, teamId: string): Promise<TeamRecord>
  update(input: {
    workspaceId: string
    actorId: string
    teamId: string
    name?: string
    charter?: string
  }): Promise<TeamRecord>
  members(workspaceId: string, teamId: string): Promise<TeamMemberRecord[]>
  addMember(input: {
    workspaceId: string
    actorId: string
    teamId: string
    userId: string
    roleOverride?: Role
  }): Promise<void>
  removeMember(input: {
    workspaceId: string
    actorId: string
    teamId: string
    userId: string
  }): Promise<void>
  /** The role a user holds *in this team*, given the role they hold in the workspace. */
  roleIn(
    workspaceId: string,
    teamId: string,
    userId: string,
    workspaceRole: Role,
  ): Promise<Role>
  setPolicy(input: {
    workspaceId: string
    actorId: string
    teamId?: string
    workflowName?: string
    checkpointKind: CheckpointKind
    mode: CheckpointMode
    spendThresholdCents?: number
  }): Promise<void>
  /** Every checkpoint kind, resolved for this team and workflow. */
  resolvePolicies(
    workspaceId: string,
    teamId: string,
    workflowName?: string,
  ): Promise<Record<CheckpointKind, ResolvedPolicy>>
}

interface TeamRow {
  id: string
  name: string
  slug: string
  charter: string
}

function validateCharter(charter: unknown): string {
  if (typeof charter !== 'string') {
    throw new ValidationError('A charter must be text', { field: 'charter' })
  }
  if (charter.length > MAX_CHARTER_LENGTH) {
    // Refused rather than truncated: the charter is injected into every agent
    // prompt, and a charter cut off mid-sentence is a corrupted instruction.
    throw new ValidationError(`A charter may be at most ${MAX_CHARTER_LENGTH} characters`, {
      field: 'charter',
      limit: MAX_CHARTER_LENGTH,
      length: charter.length,
    })
  }
  return charter
}

export function createTeamService(config: DbConfig): TeamService {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>, actorId?: string) =>
    withTenant(workspaceId, fn, { config, ...(actorId ? { userId: actorId } : {}) })

  const selectTeams = `SELECT id, name, slug, charter FROM teams WHERE deleted_at IS NULL`

  return {
    async create({ workspaceId, actorId, name, charter = '' }) {
      const trimmed = name.trim()
      if (!trimmed) throw new ValidationError('A team needs a name', { field: 'name' })
      validateCharter(charter)

      const id = ulid()

      // Reading the taken slugs and then inserting is a race, and the unique
      // index — not this read — is what actually holds the line. When a
      // concurrent create wins, retry: the caller never chose the slug, so a
      // conflict is nothing they can act on, and asking them to press the
      // button again is the system making them perform its own retry.
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await tx(
            workspaceId,
            async (t) => {
              const taken = await t.query<{ slug: string }>(
                `SELECT slug FROM teams WHERE deleted_at IS NULL`,
              )
              const slug = uniqueSlug(
                trimmed,
                taken.map((row) => row.slug),
              )

              return mutate(t, {
                workspaceId,
                actor: { type: 'user', id: actorId },
                action: 'team.create',
                targetType: 'team',
                targetId: id,
                after: { name: trimmed, slug, charter },
                apply: async () => {
                  await t.execute(
                    `INSERT INTO teams (id, workspace_id, name, slug, charter)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [id, workspaceId, trimmed, slug, charter],
                  )
                  return { id, name: trimmed, slug, charter }
                },
              })
            },
            actorId,
          )
        } catch (error) {
          // Bounded, and the bound is not silent: exhausting it surfaces the
          // "clear error" AC4 allows rather than looping forever.
          if (!String(error).includes('teams_slug_key') || attempt >= SLUG_ATTEMPTS - 1) {
            if (String(error).includes('teams_slug_key')) {
              throw new ConflictError('That team name is contended. Try again.', { name: trimmed })
            }
            throw error
          }
        }
      }
    },

    async list(workspaceId) {
      return tx(workspaceId, (t) => t.query<TeamRow>(`${selectTeams} ORDER BY created_at`))
    },

    async get(workspaceId, teamId) {
      const rows = await tx(workspaceId, (t) =>
        t.query<TeamRow>(`${selectTeams} AND id = $1`, [teamId]),
      )
      const team = rows[0]
      // Not-found rather than forbidden: a team in another workspace is
      // indistinguishable from one that does not exist (WS-2 AC4).
      if (!team) throw new NotFoundError('No such team', { teamId })
      return team
    },

    async update({ workspaceId, actorId, teamId, name, charter }) {
      if (name === undefined && charter === undefined) {
        throw new ValidationError('Nothing to update', { fields: ['name', 'charter'] })
      }
      if (charter !== undefined) validateCharter(charter)
      const trimmed = name?.trim()
      if (name !== undefined && !trimmed) {
        throw new ValidationError('A team needs a name', { field: 'name' })
      }

      const before = await this.get(workspaceId, teamId)

      return tx(
        workspaceId,
        async (t) =>
          mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            action: 'team.update',
            targetType: 'team',
            targetId: teamId,
            before: { name: before.name, charter: before.charter },
            after: { name: trimmed ?? before.name, charter: charter ?? before.charter },
            apply: async () => {
              const updated = await t.execute(
                `UPDATE teams
                    SET name = coalesce($2, name),
                        charter = coalesce($3, charter),
                        updated_at = now()
                  WHERE id = $1 AND deleted_at IS NULL`,
                [teamId, trimmed ?? null, charter ?? null],
              )
              if (updated !== 1) throw new NotFoundError('No such team', { teamId })
              return {
                id: teamId,
                name: trimmed ?? before.name,
                slug: before.slug,
                charter: charter ?? before.charter,
              }
            },
          }),
        actorId,
      )
    },

    async members(workspaceId, teamId) {
      return tx(workspaceId, (t) =>
        t.query<TeamMemberRecord>(
          `SELECT user_id AS "userId", team_id AS "teamId", role_override AS "roleOverride"
             FROM team_members
            WHERE team_id = $1 AND deleted_at IS NULL
            ORDER BY created_at`,
          [teamId],
        ),
      )
    },

    async addMember({ workspaceId, actorId, teamId, userId, roleOverride }) {
      // Establishes that the team is in this workspace before writing a row
      // that references it.
      await this.get(workspaceId, teamId)

      await tx(
        workspaceId,
        async (t) =>
          mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            action: 'team.add_member',
            targetType: 'team_member',
            targetId: userId,
            after: { teamId, roleOverride: roleOverride ?? null },
            apply: async () => {
              const membership = await t.query<{ role: Role }>(
                `SELECT role FROM workspace_members
                  WHERE user_id = $1 AND deleted_at IS NULL`,
                [userId],
              )
              // A team is a subdivision of a workspace, not a way into one.
              if (membership.length === 0) {
                throw new NotFoundError('No such member of this workspace', { userId })
              }

              // An override replaces rather than raises, so it can lower an
              // admin inside a sensitive team — but never the owner, or a team
              // could be left with nobody able to administer it and no way back
              // short of database surgery. The same hazard WS-2 AC6 guards for
              // the workspace (WS-4 AC3).
              if (
                roleOverride !== undefined &&
                roleOverride !== 'owner' &&
                membership[0]!.role === 'owner'
              ) {
                throw new ForbiddenError(
                  'An owner cannot be restricted within a team; that could leave it unadministrable.',
                  { reason: 'would_strand_team', userId },
                )
              }

              await t.execute(
                `INSERT INTO team_members (id, workspace_id, team_id, user_id, role_override)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (team_id, user_id) WHERE deleted_at IS NULL
                 DO UPDATE SET role_override = EXCLUDED.role_override, updated_at = now()`,
                [ulid(), workspaceId, teamId, userId, roleOverride ?? null],
              )
            },
          }),
        actorId,
      )
    },

    async removeMember({ workspaceId, actorId, teamId, userId }) {
      await this.get(workspaceId, teamId)

      await tx(
        workspaceId,
        async (t) =>
          mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            action: 'team.remove_member',
            targetType: 'team_member',
            targetId: userId,
            before: { teamId },
            apply: async () => {
              const removed = await t.execute(
                `UPDATE team_members SET deleted_at = now()
                  WHERE team_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
                [teamId, userId],
              )
              if (removed !== 1) throw new NotFoundError('No such team member', { userId })
            },
          }),
        actorId,
      )
    },

    async roleIn(workspaceId, teamId, userId, workspaceRole) {
      const rows = await tx(workspaceId, (t) =>
        t.query<{ role_override: Role | null }>(
          `SELECT role_override FROM team_members
            WHERE team_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [teamId, userId],
        ),
      )
      const override = rows[0]?.role_override
      return resolveRole(
        { workspaceRole, teamOverrides: override ? { [teamId]: override } : {} },
        teamId,
      )
    },

    async setPolicy({
      workspaceId,
      actorId,
      teamId,
      workflowName,
      checkpointKind,
      mode,
      spendThresholdCents,
    }) {
      if (teamId === undefined && workflowName === undefined) {
        throw new ValidationError(
          'A policy must name a team, a workflow, or both. There is no workspace-wide override.',
          { fields: ['teamId', 'workflowName'] },
        )
      }
      if (teamId !== undefined) await this.get(workspaceId, teamId)

      await tx(
        workspaceId,
        async (t) =>
          mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            action: 'policy.set',
            targetType: 'policy',
            // The tier the row belongs to, so the audit trail says which gate
            // moved rather than only that some policy changed.
            targetId: `${teamId ?? '*'}:${workflowName ?? '*'}:${checkpointKind}`,
            after: { teamId: teamId ?? null, workflowName: workflowName ?? null, checkpointKind, mode },
            apply: async () => {
              // Upsert on the tier key: two rows for one tier would let
              // insertion order decide whether a gate holds.
              await t.execute(
                `INSERT INTO policies
                   (id, workspace_id, team_id, workflow_name, checkpoint_kind, mode, spend_threshold_cents)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (workspace_id, coalesce(team_id, ''), coalesce(workflow_name, ''), checkpoint_kind)
                 WHERE deleted_at IS NULL
                 DO UPDATE SET mode = EXCLUDED.mode,
                               spend_threshold_cents = EXCLUDED.spend_threshold_cents,
                               updated_at = now()`,
                [
                  ulid(),
                  workspaceId,
                  teamId ?? null,
                  workflowName ?? null,
                  checkpointKind,
                  mode,
                  spendThresholdCents ?? null,
                ],
              )
            },
          }),
        actorId,
      )
    },

    async resolvePolicies(workspaceId, teamId, workflowName) {
      await this.get(workspaceId, teamId)

      // Every rule that could bear on this team, resolved in memory by the one
      // implementation in packages/core. Encoding the precedence as SQL would
      // make it a second implementation that could drift from the agent
      // runtime's — and a drift here is a gate that silently stopped gating.
      const rows = await tx(workspaceId, (t) =>
        t.query<{
          team_id: string | null
          workflow_name: string | null
          checkpoint_kind: CheckpointKind
          mode: CheckpointMode
          spend_threshold_cents: number | null
        }>(
          `SELECT team_id, workflow_name, checkpoint_kind, mode, spend_threshold_cents
             FROM policies
            WHERE deleted_at IS NULL AND (team_id IS NULL OR team_id = $1)`,
          [teamId],
        ),
      )

      const rules: PolicyRule[] = rows.map((row) => ({
        ...(row.team_id === null ? {} : { teamId: row.team_id }),
        ...(row.workflow_name === null ? {} : { workflowName: row.workflow_name }),
        checkpointKind: row.checkpoint_kind,
        mode: row.mode,
        ...(row.spend_threshold_cents === null
          ? {}
          : { spendThresholdCents: row.spend_threshold_cents }),
      }))

      const resolved = {} as Record<CheckpointKind, ResolvedPolicy>
      for (const checkpointKind of CHECKPOINT_KINDS) {
        resolved[checkpointKind] = resolveCheckpointPolicy(rules, {
          teamId,
          checkpointKind,
          ...(workflowName === undefined ? {} : { workflowName }),
        })
      }
      return resolved
    },
  }
}
