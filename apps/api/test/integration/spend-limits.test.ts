import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid } from '@chorus/core'
import { createSpendLimitService, type SpendLimitService } from '../../src/spend-limits.js'

/**
 * WS-7 — the spend limit service against a real database.
 *
 * One seam: the service and Postgres. What only exists when both are present is
 * that a scope holds exactly one row however often it is replaced (the guard
 * reads whichever row it finds, so two would make which limit binds a matter
 * of chance), and that row-level security, not the service, keeps another
 * workspace's limits and teams out of reach.
 */
describe('WS-7 spend limit service', () => {
  let db: IsolatedDatabase
  let limits: SpendLimitService
  const workspaceId = ulid()
  const otherWorkspaceId = ulid()
  let userId: string
  let otherTeamId: string

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    limits = createSpendLimitService(db.config)
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.seedWorkspace(otherWorkspaceId)
    const [member] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1`,
      [workspaceId],
    )
    userId = member!.user_id
    otherTeamId = ulid()
    await db.admin.execute(
      `INSERT INTO teams (id, workspace_id, name, slug) VALUES ($1, $2, 'Elsewhere', 'elsewhere')`,
      [otherTeamId, otherWorkspaceId],
    )
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  const rowsFor = (id: string) =>
    db.admin.query<{ hard_limit_cents: number }>(
      `SELECT hard_limit_cents FROM spend_limits WHERE workspace_id = $1 AND team_id IS NULL`,
      [id],
    )

  it('WS-7 AC3: replacing a limit leaves exactly one row for the scope', async () => {
    for (const hardLimitCents of [100, 200, 300]) {
      await limits.set({
        workspaceId,
        actorId: userId,
        teamId: null,
        limit: { period: 'month', softLimitCents: null, hardLimitCents },
      })
    }

    expect(await rowsFor(workspaceId)).toEqual([{ hard_limit_cents: 300 }])
  })

  it('WS-7: the mutation and its audit event are written together', async () => {
    const before = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE workspace_id = $1 AND action = 'workspace.spend_limit.set'`,
      [workspaceId],
    )
    await limits.set({ workspaceId, actorId: userId, teamId: null, limit: null })
    const after = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE workspace_id = $1 AND action = 'workspace.spend_limit.set'`,
      [workspaceId],
    )

    expect(after[0]!.n).toBe(before[0]!.n + 1)
    expect(await rowsFor(workspaceId)).toEqual([])
  })

  it("WS-7: another workspace's limits are not listed, and its teams cannot be limited", async () => {
    const mine = await limits.list(workspaceId)
    await limits.set({
      workspaceId: otherWorkspaceId,
      actorId: userId,
      teamId: null,
      limit: { period: 'day', softLimitCents: 5, hardLimitCents: null },
    })

    expect(await limits.list(workspaceId)).toEqual(mine)
    await expect(
      limits.set({
        workspaceId,
        actorId: userId,
        teamId: otherTeamId,
        limit: { period: 'month', softLimitCents: null, hardLimitCents: 1 },
      }),
    ).rejects.toMatchObject({ status: 404 })
    expect(
      await db.admin.query(`SELECT 1 FROM spend_limits WHERE team_id = $1`, [otherTeamId]),
    ).toEqual([])
  })
})
