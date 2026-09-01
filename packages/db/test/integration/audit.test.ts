import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid } from '@chorus/core'
import {
  createIsolatedDatabase,
  withTenant,
  mutate,
  type AdminConnection,
  type IsolatedDatabase,
} from '../../src/index.js'

/**
 * NFR-5 AC1 — every mutation writes its audit event in the *same transaction*.
 *
 * An audit row written afterwards is an audit row that is missing exactly when
 * something went wrong: the failure that rolled back the change also skipped
 * the record of it. Atomicity in both directions is the whole guarantee.
 */
describe('NFR-5 audit trail', () => {
  let db: IsolatedDatabase
  let admin: AdminConnection
  const workspaceId = ulid()
  let userId: string

  beforeAll(async () => {
    // A database of this file's own, so the suite is parallel-safe (CLAUDE.md §5).
    db = await createIsolatedDatabase()
    admin = db.admin
    await admin.seedWorkspace(workspaceId)
    const [member] = await admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1`,
      [workspaceId],
    )
    userId = member!.user_id
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  const auditCount = async (): Promise<number> => {
    const [row] = await admin.query<{ count: string }>(
      `SELECT count(*) FROM audit_events WHERE workspace_id = $1 AND action = 'team.create'`,
      [workspaceId],
    )
    return Number(row!.count)
  }

  it('NFR-5 AC1: a successful mutation writes exactly one audit event', async () => {
    const before = await auditCount()
    const teamId = ulid()

    await withTenant(
      workspaceId,
      async (tx) =>
        mutate(tx, {
          workspaceId,
          actor: { type: 'user', id: userId },
          action: 'team.create',
          targetType: 'team',
          targetId: teamId,
          after: { name: 'Platform' },
          apply: async () => {
            await tx.execute(
              `INSERT INTO teams (id, workspace_id, name, slug) VALUES ($1, $2, 'Platform', $1)`,
              [teamId, workspaceId],
            )
          },
        }),
      { userId, config: db.config },
    )

    expect(await auditCount()).toBe(before + 1)

    const [event] = await admin.query<Record<string, unknown>>(
      `SELECT actor_type, actor_id, action, target_type, target_id, after
         FROM audit_events WHERE target_id = $1`,
      [teamId],
    )
    expect(event).toMatchObject({
      actor_type: 'user',
      actor_id: userId,
      action: 'team.create',
      target_type: 'team',
      target_id: teamId,
      after: { name: 'Platform' },
    })
  })

  it('NFR-5 AC1: a rolled-back change leaves no audit row — the two are atomic together', async () => {
    const before = await auditCount()
    const teamId = ulid()

    await expect(
      withTenant(
        workspaceId,
        async (tx) =>
          mutate(tx, {
            workspaceId,
            actor: { type: 'user', id: userId },
            action: 'team.create',
            targetType: 'team',
            targetId: teamId,
            apply: async () => {
              await tx.execute(
                `INSERT INTO teams (id, workspace_id, name, slug) VALUES ($1, $2, 'Doomed', $1)`,
                [teamId, workspaceId],
              )
              throw new Error('something failed after the write')
            },
          }),
        { userId, config: db.config },
      ),
    ).rejects.toThrow('something failed after the write')

    expect(await auditCount(), 'audit row survived a rollback').toBe(before)

    const rows = await admin.query(`SELECT 1 FROM teams WHERE id = $1`, [teamId])
    expect(rows.length, 'the team survived a rollback').toBe(0)
  })

  it('NFR-5 AC1: an audit failure rolls back the change, so a mutation is never unrecorded', async () => {
    const teamId = ulid()

    await expect(
      withTenant(
        workspaceId,
        async (tx) =>
          mutate(tx, {
            workspaceId,
            actor: { type: 'user', id: userId },
            // An action longer than the column allows forces the audit insert
            // to fail after the change has been applied.
            action: 'x'.repeat(10_000),
            targetType: 'team',
            targetId: teamId,
            apply: async () => {
              await tx.execute(
                `INSERT INTO teams (id, workspace_id, name, slug) VALUES ($1, $2, 'Unrecorded', $1)`,
                [teamId, workspaceId],
              )
            },
          }),
        { userId, config: db.config },
      ),
    ).rejects.toThrow()

    const rows = await admin.query(`SELECT 1 FROM teams WHERE id = $1`, [teamId])
    expect(rows.length, 'a change was applied without being audited').toBe(0)
  })

  it('NFR-5 AC4: agent actions are attributable to a run, not to a person', async () => {
    const runId = ulid()
    const teamId = ulid()

    await withTenant(
      workspaceId,
      async (tx) =>
        mutate(tx, {
          workspaceId,
          actor: { type: 'run', id: runId },
          action: 'team.create',
          targetType: 'team',
          targetId: teamId,
          apply: async () => {
            await tx.execute(
              `INSERT INTO teams (id, workspace_id, name, slug) VALUES ($1, $2, 'Agent made', $1)`,
              [teamId, workspaceId],
            )
          },
        }),
      { userId, config: db.config },
    )

    const [event] = await admin.query<{ actor_type: string; actor_id: string }>(
      `SELECT actor_type, actor_id FROM audit_events WHERE target_id = $1`,
      [teamId],
    )
    expect(event).toMatchObject({ actor_type: 'run', actor_id: runId })
  })

  it('NFR-3: an audit event cannot be written into another workspace', async () => {
    const otherWorkspace = ulid()
    await admin.seedWorkspace(otherWorkspace)

    await expect(
      withTenant(workspaceId, async (tx) =>
        mutate(tx, {
          workspaceId: otherWorkspace,
          actor: { type: 'user', id: userId },
          action: 'team.create',
          targetType: 'team',
          targetId: ulid(),
          apply: async () => {},
        }),
      { config: db.config },
      ),
    ).rejects.toThrow()
  })
})
