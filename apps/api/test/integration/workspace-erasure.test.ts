import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid } from '@chorus/core'
import { createWorkspaceErasure } from '../../src/workspace-erasure.js'

/**
 * NFR-4 AC5 — erasure is complete.
 *
 * `seedWorkspace` plants a row in every tenant table, so "nothing left" here
 * means every table, not the ones someone remembered. The residue check walks
 * the schema itself — every table carrying `workspace_id` — rather than trusting
 * the erasure's own report, because manual erasure code always misses
 * something. And a second workspace proves the erasure took exactly one.
 */
describe('NFR-4 workspace erasure', () => {
  let db: IsolatedDatabase

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  /** Every table carrying workspace_id, and how many rows it holds for one workspace. */
  async function rowsByTable(workspaceId: string): Promise<Record<string, number>> {
    const tables = await db.admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'workspace_id' ORDER BY table_name`,
    )
    const counts: Record<string, number> = {}
    for (const { table_name } of tables) {
      const [row] = await db.admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table_name} WHERE workspace_id = $1`,
        [workspaceId],
      )
      counts[table_name] = Number(row!.n)
    }
    return counts
  }

  it('NFR-4 AC5: every workspace-owned row is removed, and nothing of another workspace', async () => {
    const doomed = ulid()
    const kept = ulid()
    await db.admin.seedWorkspace(doomed)
    await db.admin.seedWorkspace(kept)
    const [owner] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner' LIMIT 1`,
      [doomed],
    )
    const keptBefore = await rowsByTable(kept)
    // The seed really did plant something everywhere, or this test proves nothing.
    expect(Object.values(await rowsByTable(doomed)).every((n) => n > 0)).toBe(true)

    const outcome = await createWorkspaceErasure(db.config).erase({ workspaceId: doomed, actorId: owner!.user_id })

    expect(outcome.residue).toEqual([])
    expect(outcome.tablesVerified).toBe(Object.keys(keptBefore).length)
    const doomedAfter = await rowsByTable(doomed)
    expect(Object.entries(doomedAfter).filter(([, n]) => n > 0), 'no table may hold the erased workspace').toEqual([])
    expect(await db.admin.query(`SELECT id FROM workspaces WHERE id = $1`, [doomed])).toEqual([])

    expect(await rowsByTable(kept), 'the other workspace is untouched').toEqual(keptBefore)
  })

  it('NFR-4 AC6: the erasure is recorded where the erasure cannot remove it', async () => {
    const doomed = ulid()
    await db.admin.seedWorkspace(doomed)
    const [owner] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner' LIMIT 1`,
      [doomed],
    )
    const [workspace] = await db.admin.query<{ name: string }>(`SELECT name FROM workspaces WHERE id = $1`, [doomed])

    await createWorkspaceErasure(db.config).erase({ workspaceId: doomed, actorId: owner!.user_id })

    // The workspace's own audit trail went with it, so the record lives outside it.
    const records = await db.admin.query<{
      erased_workspace_id: string
      workspace_name: string
      erased_by: string
      tables_verified: number
      residue: unknown[]
    }>(`SELECT erased_workspace_id, workspace_name, erased_by, tables_verified, residue FROM workspace_erasures
         WHERE erased_workspace_id = $1`, [doomed])
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      erased_workspace_id: doomed,
      workspace_name: workspace!.name,
      erased_by: owner!.user_id,
      residue: [],
    })
    expect(records[0]!.tables_verified).toBeGreaterThan(0)
  })
})
