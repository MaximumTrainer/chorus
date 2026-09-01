import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  createIsolatedDatabase,
  withTenant,
  TENANT_TABLES,
  type AdminConnection,
  type IsolatedDatabase,
  type TenantTx,
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
  let db: IsolatedDatabase
  let admin: AdminConnection
  const workspaceA = ulid()
  const workspaceB = ulid()

  beforeAll(async () => {
    // A database of this file's own, so the suite is parallel-safe (CLAUDE.md §5).
    db = await createIsolatedDatabase()
    admin = db.admin

    // Two workspaces, each with one row in every tenant table, inserted as
    // admin so the test does not depend on the code paths it is testing.
    await admin.seedWorkspace(workspaceA)
    await admin.seedWorkspace(workspaceB)
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  /** Every tenant query targets this file's own database, not the shared one. */
  const asWorkspace = <T>(workspaceId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenant(workspaceId, fn, { config: db.config })

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
      const rows = await asWorkspace(workspaceA, async (tx) =>
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
      const affected = await asWorkspace(workspaceA, async (tx) =>
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
      const affected = await asWorkspace(workspaceA, async (tx) =>
        tx.execute(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceB]),
      )
      expect(affected, `${table}: workspace A deleted ${affected} of B's rows`).toBe(0)

      // B's rows must still be there.
      const remaining = await asWorkspace(workspaceB, async (tx) =>
        tx.query(`SELECT 1 FROM ${table}`),
      )
      expect(remaining.length, `${table}: B's rows were destroyed`).toBeGreaterThan(0)
    },
  )

  it.each([...TENANT_TABLES])(
    'NFR-3 AC2: %s — a row cannot be inserted into another workspace',
    async (table) => {
      await expect(
        asWorkspace(workspaceA, async (tx) => admin.insertMinimalRow(tx, table, workspaceB)),
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

/**
 * NFR-3 — the two deliberate widenings of the tenancy boundary.
 *
 * Migrations 0004 and 0005 each admit rows that a strict `workspace_id` match
 * would refuse, because membership discovery and invitation redemption both
 * have to happen before a tenant context exists. A widening that is not tested
 * at its edges is just a hole, so each is pinned here: what it permits, and —
 * more importantly — what it still refuses.
 */
describe('NFR-3 deliberate policy widenings', () => {
  let db: IsolatedDatabase
  let admin: AdminConnection
  const alpha = ulid()
  const beta = ulid()
  let alphaUser: string
  let betaUser: string

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    admin = db.admin
    await admin.seedWorkspace(alpha)
    await admin.seedWorkspace(beta)
    const [a] = await admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1`,
      [alpha],
    )
    const [b] = await admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1`,
      [beta],
    )
    alphaUser = a!.user_id
    betaUser = b!.user_id
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('NFR-3 / 0004: a user sees their own membership rows without a tenant context', async () => {
    const rows = await withTenant(
      '__none__',
      (tx) => tx.query<{ user_id: string }>(`SELECT user_id FROM workspace_members`),
      { config: db.config, userId: alphaUser },
    )
    expect(rows.length, "the caller's own membership must be discoverable").toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.user_id, "only the caller's own rows may be visible").toBe(alphaUser)
    }
  })

  it("NFR-3 / 0004: a user cannot see anyone else's membership in another workspace", async () => {
    const rows = await withTenant(
      alpha,
      (tx) =>
        tx.query<{ user_id: string; workspace_id: string }>(
          `SELECT user_id, workspace_id FROM workspace_members WHERE workspace_id = $1`,
          [beta],
        ),
      { config: db.config, userId: alphaUser },
    )
    expect(rows, "another workspace's membership list must stay hidden").toEqual([])
    expect(betaUser).not.toBe(alphaUser)
  })

  it('NFR-3 / 0004: seeing your membership elsewhere does not let you grant yourself one', async () => {
    await expect(
      withTenant(
        '__none__',
        (tx) =>
          tx.execute(
            `INSERT INTO workspace_members (id, workspace_id, user_id, role)
             VALUES ($1, $2, $3, 'owner')`,
            [ulid(), beta, alphaUser],
          ),
        { config: db.config, userId: alphaUser },
      ),
    ).rejects.toThrow()
  })

  it('NFR-3 / 0005: presenting an invitation token reveals exactly that invitation', async () => {
    const [invitation] = await admin.query<{ token_hash: string; id: string }>(
      `SELECT token_hash, id FROM invitations WHERE workspace_id = $1`,
      [beta],
    )

    const rows = await withTenant(
      '__none__',
      (tx) => tx.query<{ id: string }>(`SELECT id FROM invitations`),
      {
        config: db.config,
        settings: { 'app.invitation_token': invitation!.token_hash },
      },
    )
    expect(rows.map((r) => r.id), 'exactly the presented invitation, and no other').toEqual([
      invitation!.id,
    ])
  })

  it('NFR-3 / 0005: holding no token reveals no invitation at all', async () => {
    const rows = await withTenant(
      '__none__',
      (tx) => tx.query(`SELECT id FROM invitations`),
      { config: db.config },
    )
    expect(rows, 'an unset setting must fail closed, not match everything').toEqual([])
  })

  it('NFR-3 / 0005: holding a token does not permit minting or altering an invitation', async () => {
    const [invitation] = await admin.query<{ token_hash: string }>(
      `SELECT token_hash FROM invitations WHERE workspace_id = $1`,
      [beta],
    )
    // The WITH CHECK clause rejects the write outright rather than matching no
    // rows -- stricter than merely refusing to find the row, and worth pinning
    // as the actual behaviour rather than the weaker one first assumed.
    await expect(
      withTenant(
        '__none__',
        (tx) =>
          tx.execute(`UPDATE invitations SET role = 'owner' WHERE token_hash = $1`, [
            invitation!.token_hash,
          ]),
        { config: db.config, settings: { 'app.invitation_token': invitation!.token_hash } },
      ),
      'a token holder must not be able to escalate their invitation',
    ).rejects.toThrow(/row-level security/)
  })
})
