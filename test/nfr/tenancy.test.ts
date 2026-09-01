import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  connectAdmin,
  applyMigrations,
  withTenant,
  TENANT_TABLES,
  resetDatabase,
  type AdminConnection,
} from '@chorus/db'
import { ulid } from '@chorus/core'

/**
 * NFR-3 AC1, AC2 — workspace isolation, enforced by the database.
 *
 * This is the suite plan.md §5 says starts in Phase 0 and gains a case for
 * every tenant table thereafter. It enumerates tables from the schema rather
 * than from a hand-written list, because a hand-written list is out of date the
 * first time someone adds a table.
 *
 * The application role has no BYPASSRLS. A superuser connection would silently
 * disable every policy and make this entire suite pass while proving nothing —
 * so that is asserted explicitly.
 */
describe('NFR-3 workspace isolation', () => {
  let admin: AdminConnection
  const workspaceA = ulid()
  const workspaceB = ulid()

  beforeAll(async () => {
    admin = await connectAdmin()
    await resetDatabase(admin)
    await applyMigrations(admin)

    // Two workspaces, each with one row in every tenant table, inserted as
    // admin so the test does not depend on the code paths it is testing.
    await admin.seedWorkspace(workspaceA)
    await admin.seedWorkspace(workspaceB)
  }, 120_000)

  afterAll(async () => {
    await admin?.close()
  })

  it('NFR-3: the application role cannot bypass row-level security', async () => {
    const [{ rolbypassrls, rolsuper }] = await admin.query<{
      rolbypassrls: boolean
      rolsuper: boolean
    }>(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_setting('chorus.app_role')`)
    expect(rolbypassrls, 'the application role must not have BYPASSRLS').toBe(false)
    expect(rolsuper, 'the application role must not be a superuser').toBe(false)
  })

  it('NFR-3 AC1: every tenant table has row-level security enabled and a policy', async () => {
    for (const table of TENANT_TABLES) {
      const [row] = await admin.query<{ relrowsecurity: boolean; policies: number }>(
        `SELECT c.relrowsecurity,
                (SELECT count(*)::int FROM pg_policies p
                  WHERE p.tablename = c.relname) AS policies
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = $1 AND n.nspname = 'public'`,
        [table],
      )
      expect(row, `table ${table} does not exist`).toBeDefined()
      expect(row!.relrowsecurity, `${table} must have RLS enabled`).toBe(true)
      expect(row!.policies, `${table} must have at least one policy`).toBeGreaterThan(0)
    }
  })

  it('NFR-3: the tenant table list is derived from the schema, not hand-maintained', async () => {
    const rows = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'workspace_id'
        ORDER BY table_name`,
    )
    const withWorkspaceId = rows.map((r) => r.table_name)
    expect(
      [...TENANT_TABLES].sort(),
      'every table carrying workspace_id must be in TENANT_TABLES',
    ).toEqual(withWorkspaceId.sort())
  })

  it.each([...TENANT_TABLES])(
    'NFR-3 AC2: %s — workspace A cannot read a row belonging to workspace B',
    async (table) => {
      const rows = await withTenant(workspaceA, async (tx) =>
        tx.query<{ workspace_id: string }>(`SELECT workspace_id FROM ${table}`),
      )
      expect(rows.length, `${table}: expected A's own seeded row to be visible`).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.workspace_id, `${table} leaked a row from another workspace`).toBe(workspaceA)
      }
    },
  )

  it.each([...TENANT_TABLES])(
    'NFR-3 AC2: %s — workspace A cannot update a row belonging to workspace B',
    async (table) => {
      const affected = await withTenant(workspaceA, async (tx) =>
        tx.execute(`UPDATE ${table} SET workspace_id = workspace_id WHERE workspace_id = $1`, [
          workspaceB,
        ]),
      )
      expect(affected, `${table}: workspace A updated ${affected} of B's rows`).toBe(0)
    },
  )

  it.each([...TENANT_TABLES])(
    'NFR-3 AC2: %s — workspace A cannot delete a row belonging to workspace B',
    async (table) => {
      const affected = await withTenant(workspaceA, async (tx) =>
        tx.execute(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceB]),
      )
      expect(affected, `${table}: workspace A deleted ${affected} of B's rows`).toBe(0)

      // B's rows must still be there.
      const remaining = await withTenant(workspaceB, async (tx) =>
        tx.query(`SELECT 1 FROM ${table}`),
      )
      expect(remaining.length, `${table}: B's rows were destroyed`).toBeGreaterThan(0)
    },
  )

  it.each([...TENANT_TABLES])(
    'NFR-3 AC2: %s — a row cannot be inserted into another workspace',
    async (table) => {
      await expect(
        withTenant(workspaceA, async (tx) => admin.insertMinimalRow(tx, table, workspaceB)),
      ).rejects.toThrow()
    },
  )

  it('NFR-3: a query issued without a tenant context reads nothing at all', async () => {
    // Belt and braces: if the session variable is unset, policies must fail
    // closed rather than defaulting to a permissive match.
    for (const table of TENANT_TABLES) {
      const rows = await admin.queryAsAppRoleWithoutTenant(`SELECT 1 FROM ${table}`)
      expect(rows.length, `${table} returned rows with no tenant set`).toBe(0)
    }
  })
})
