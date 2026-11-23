import { NotFoundError, ulid, type SpendLimitInput, type SpendPeriod } from '@chorus/core'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Spend limits as admins set them (WS-7 AC3, architecture.md §9.3).
 *
 * This writes the rows NFR-8's guard already reads (`spend_limits`, migration
 * 0038), and nothing else: there is no second notion of a limit here, and no
 * counter of its own — spend is the ledger's, and enforcement is the
 * executor's. One row per scope: the workspace's (`team_id` null) and at most
 * one per team.
 */

export interface SpendLimitView {
  readonly teamId: string | null
  readonly period: SpendPeriod
  readonly softLimitCents: number | null
  readonly hardLimitCents: number | null
}

export interface SpendLimitService {
  /** The workspace's limit first, then each team's, in a stable order. */
  list(workspaceId: string): Promise<SpendLimitView[]>
  /**
   * Replace one scope's limit, or remove it when `limit` is null. A team in
   * another workspace is not found. Audited with both sides.
   */
  set(input: {
    workspaceId: string
    actorId: string
    teamId: string | null
    limit: SpendLimitInput | null
  }): Promise<SpendLimitView | null>
}

interface Row {
  team_id: string | null
  period: SpendPeriod
  soft_limit_cents: number | null
  hard_limit_cents: number | null
}

const view = (row: Row): SpendLimitView => ({
  teamId: row.team_id,
  period: row.period,
  softLimitCents: row.soft_limit_cents,
  hardLimitCents: row.hard_limit_cents,
})

const columns = `team_id, period, soft_limit_cents, hard_limit_cents`

export function createSpendLimitService(config: DbConfig): SpendLimitService {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>, userId?: string): Promise<T> =>
    withTenant(workspaceId, fn, { config, ...(userId ? { userId } : {}) })

  const current = async (t: TenantTx, teamId: string | null): Promise<SpendLimitView | null> => {
    const rows = await t.query<Row>(
      `SELECT ${columns} FROM spend_limits WHERE team_id IS NOT DISTINCT FROM $1`,
      [teamId],
    )
    return rows[0] ? view(rows[0]) : null
  }

  return {
    async list(workspaceId) {
      const rows = await tx(workspaceId, (t) =>
        t.query<Row>(
          `SELECT ${columns} FROM spend_limits ORDER BY team_id NULLS FIRST, team_id`,
        ),
      )
      return rows.map(view)
    },

    async set({ workspaceId, actorId, teamId, limit }) {
      return tx(
        workspaceId,
        async (t) => {
          if (teamId !== null) {
            // Row-level security confines this to the caller's workspace, so a
            // team elsewhere is indistinguishable from one that does not exist.
            const [team] = await t.query<{ id: string }>(`SELECT id FROM teams WHERE id = $1`, [
              teamId,
            ])
            if (!team) throw new NotFoundError('No such team', { teamId })
          }

          const before = await current(t, teamId)
          const after: SpendLimitView | null = limit === null ? null : { teamId, ...limit }

          return mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            // Raising a hard limit is exactly the change somebody would make
            // quietly, so the record names both sides of it.
            action: 'workspace.spend_limit.set',
            targetType: 'spend_limit',
            targetId: teamId ?? workspaceId,
            before,
            after,
            apply: async () => {
              if (limit === null) {
                await t.execute(`DELETE FROM spend_limits WHERE team_id IS NOT DISTINCT FROM $1`, [
                  teamId,
                ])
                return null
              }
              await t.execute(
                `INSERT INTO spend_limits
                   (id, workspace_id, team_id, period, soft_limit_cents, hard_limit_cents)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (workspace_id, coalesce(team_id, ''))
                 DO UPDATE SET period = EXCLUDED.period,
                               soft_limit_cents = EXCLUDED.soft_limit_cents,
                               hard_limit_cents = EXCLUDED.hard_limit_cents,
                               updated_at = now()`,
                [ulid(), workspaceId, teamId, limit.period, limit.softLimitCents, limit.hardLimitCents],
              )
              return after
            },
          })
        },
        actorId,
      )
    },
  }
}
