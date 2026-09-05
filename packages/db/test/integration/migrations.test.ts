import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIsolatedDatabase, applyMigrations, type IsolatedDatabase } from '../../src/index.js'

/**
 * NFR-1 AC5 — a deployment that restarts must come back up.
 *
 * `docker compose up` runs the migrator on every start, so "forward-only"
 * has to mean *forward from where this database already is*, not "from
 * nothing". Without a ledger the second start fails on the first
 * `CREATE TABLE`, which is the ordinary development loop and every restart of
 * every deployment whose volumes were not wiped. CI never saw it because CI
 * always begins with empty volumes.
 *
 * The assertions are about what survives a second run: the schema, the record
 * of what produced it, and the refusal to proceed when those two disagree.
 */
describe('NFR-1 migrations', () => {
  let db: IsolatedDatabase
  const tempDirs: string[] = []

  beforeAll(async () => {
    // A database of this file's own, so the suite is parallel-safe (CLAUDE.md §5).
    // Creating it already applies every migration once — this file is about
    // what the *next* run does.
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  })

  /** A migration directory of this test's own, with the given files in it. */
  const migrationsIn = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'chorus-migrations-'))
    tempDirs.push(dir)
    for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql, 'utf8')
    return dir
  }

  const tableExists = async (name: string): Promise<boolean> => {
    const rows = await db.admin.query<{ count: string }>(
      `SELECT count(*) FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1`,
      [name],
    )
    return Number(rows[0]!.count) === 1
  }

  const ledger = async (): Promise<{ filename: string; checksum: string }[]> =>
    db.admin.query<{ filename: string; checksum: string }>(
      `SELECT filename, checksum FROM schema_migrations ORDER BY filename`,
    )

  it('NFR-1 AC5: a second run applies nothing and leaves the schema standing', async () => {
    // Given a database that has already been migrated once (beforeAll)
    const before = await tableExists('users')
    expect(before, 'the first run should have created the schema').toBe(true)

    // When the migrator runs again, as it does on every restart
    const applied = await applyMigrations(db.admin)

    // Then it applied nothing, and did not fail on a table that already exists
    expect(applied).toEqual([])
    expect(await tableExists('users')).toBe(true)
  })

  it('NFR-1 AC5: every migration that ran is recorded, with the bytes it ran', async () => {
    // Given the migrated database
    // When the ledger is read
    const rows = await ledger()

    // Then there is one row per migration file, each carrying a checksum of
    // what was executed — a filename alone cannot detect an edit.
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.map((r) => r.filename)).toContain('0001_identity.sql')
    for (const row of rows) {
      expect(row.checksum, `${row.filename} has no checksum`).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('NFR-1 AC5: a migration edited after it was applied is refused, not skipped', async () => {
    // Given a migration that has been applied
    const dir = migrationsIn({
      '9001_probe.sql': `CREATE TABLE migration_probe_edited (id text PRIMARY KEY);`,
    })
    await applyMigrations(db.admin, { dir })

    // When its contents change and the migrator runs again
    writeFileSync(
      join(dir, '9001_probe.sql'),
      `CREATE TABLE migration_probe_edited (id text PRIMARY KEY, extra text);`,
      'utf8',
    )

    // Then it refuses, naming the file. Two deployments claiming the same
    // version with different schemas is worse than a loud failure.
    await expect(applyMigrations(db.admin, { dir })).rejects.toThrow(/9001_probe\.sql/)
  })

  it('NFR-1 AC5: a migration that fails leaves neither its schema change nor a ledger row', async () => {
    // Given a migration whose second statement fails
    const dir = migrationsIn({
      '9002_broken.sql': `CREATE TABLE migration_probe_broken (id text PRIMARY KEY);
SELECT 1 / 0;`,
    })

    // When it runs
    await expect(applyMigrations(db.admin, { dir })).rejects.toThrow()

    // Then the table it half-created is gone, and it is not recorded as applied
    expect(await tableExists('migration_probe_broken')).toBe(false)
    expect((await ledger()).map((r) => r.filename)).not.toContain('9002_broken.sql')
  })

  /**
   * A database created by the pre-ledger runner has the whole schema and no
   * record of it. Every deployment that exists today is in exactly that state,
   * so the upgrade AC5 asks about *is* this case.
   *
   * Simulated in place rather than in a second database of its own: dropping an
   * isolated database closes the centrally managed pools, which would pull the
   * connection out from under the rest of this file.
   */
  const asPreLedgerDatabase = async (fn: () => Promise<void>): Promise<void> => {
    const rows = await ledger()
    await db.admin.execute(`DROP TABLE schema_migrations`)
    try {
      await fn()
    } finally {
      await db.admin.execute(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          filename   text PRIMARY KEY,
          checksum   text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      for (const row of rows) {
        await db.admin.execute(
          `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)
             ON CONFLICT (filename) DO NOTHING`,
          [row.filename, row.checksum],
        )
      }
    }
  }

  it('NFR-1 AC5: a database migrated before the ledger existed is refused, with the way forward', async () => {
    await asPreLedgerDatabase(async () => {
      // Given a database whose schema predates the ledger
      // When the migrator runs
      const failure = applyMigrations(db.admin)

      // Then it says what it found rather than colliding with the schema, and
      // names the one-time step. Adopting silently would record migrations as
      // applied that this database may never have seen.
      await expect(failure).rejects.toThrow(/baseline/i)
      expect(await tableExists('users'), 'the schema must be left alone').toBe(true)
    })
  })

  it('NFR-1 AC5: baselining adopts the existing schema, and the restart after it is a no-op', async () => {
    await asPreLedgerDatabase(async () => {
      // Given that same database
      // When it is baselined once
      const adopted = await applyMigrations(db.admin, { baseline: true })

      // Then every migration is recorded without being re-run, and the restart
      // that follows applies nothing at all
      expect(adopted).toEqual([])
      const recorded = await ledger()
      expect(recorded.map((r) => r.filename)).toContain('0001_identity.sql')
      expect(await applyMigrations(db.admin)).toEqual([])
    })
  })

  it('NFR-1 AC5: a migration added later is applied on the next run, and only it', async () => {
    // Given a directory whose first migration has already been applied
    const dir = migrationsIn({
      '9003_first.sql': `CREATE TABLE migration_probe_first (id text PRIMARY KEY);`,
    })
    await applyMigrations(db.admin, { dir })

    // When a later migration joins it
    writeFileSync(
      join(dir, '9004_second.sql'),
      `CREATE TABLE migration_probe_second (id text PRIMARY KEY);`,
      'utf8',
    )
    const applied = await applyMigrations(db.admin, { dir })

    // Then only the new one runs
    expect(applied).toEqual(['9004_second.sql'])
    expect(await tableExists('migration_probe_second')).toBe(true)
  })
})
