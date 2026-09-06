import pg from 'pg'
import { randomBytes } from 'node:crypto'
import { closePool, configFromEnv, type DbConfig } from './client.js'
import { connectAdmin, applyMigrations, type AdminConnection } from './admin.js'

/**
 * A database of its own, per test file.
 *
 * CLAUDE.md §5 requires the suite to be parallel-safe. Several suites need to
 * assert against a freshly migrated schema, and if they share one database each
 * `DROP SCHEMA` destroys the others' fixtures — a race that only appears once
 * two such files land in the same vitest project, which is exactly the kind of
 * flake that gets "fixed" with a retry.
 *
 * Creating a database per file removes the shared resource entirely, and keeps
 * the tenancy assertions faithful: roles, grants and RLS policies are all
 * exercised for real rather than approximated by a schema prefix.
 */

export interface IsolatedDatabase {
  readonly config: DbConfig
  readonly admin: AdminConnection
  /**
   * Drop the database and close every connection to it.
   *
   * `onProblem` is called instead of throwing when the drop cannot finish.
   * A drop that fails during `afterAll` must not fail the suite — the tests
   * passed — but it must not be silent either: eleven of these accumulated
   * unnoticed and turned a 30s suite into 3043s (#158).
   */
  drop(options?: { onProblem?: (message: string) => void }): Promise<void>
}

/**
 * The prefix every per-file database shares, and the shape of its name.
 *
 * The creation time is in the name because Postgres records none for a
 * database. Without it a sweep can only choose between dropping nothing and
 * dropping databases a parallel run is still using.
 */
const TEST_DATABASE_PREFIX = 'chorus_test_'

/**
 * Drops abandoned test databases, keeping any young enough to belong to a run
 * that is still going (#158).
 *
 * Age rather than a blanket drop: suites run in parallel here, and a sweep
 * that took the others with it would be a worse bug than the leak it fixes.
 */
export async function sweepStaleTestDatabases(
  options: { olderThanMs?: number; config?: DbConfig } = {},
): Promise<string[]> {
  const base = options.config ?? configFromEnv()
  const cutoff = Date.now() - (options.olderThanMs ?? 30 * 60 * 1000)

  const maintenance = new pg.Pool({
    host: base.host,
    port: base.port,
    database: base.database,
    user: base.ownerUser,
    password: base.ownerPassword,
    max: 1,
  })
  maintenance.on('error', () => {
    /* a sweep is best-effort; the run it precedes matters more */
  })

  try {
    const { rows } = await maintenance.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE $1`,
      [`${TEST_DATABASE_PREFIX}%`],
    )

    const dropped: string[] = []
    for (const { datname } of rows) {
      const stamp = Number(datname.slice(TEST_DATABASE_PREFIX.length).split('_')[0])
      // A name without a readable stamp predates this scheme. Left alone: it
      // is somebody else's, and guessing is how a sweep deletes live work.
      if (!Number.isFinite(stamp) || stamp === 0 || stamp >= cutoff) continue
      try {
        await maintenance.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [datname],
        )
        await maintenance.query(`DROP DATABASE IF EXISTS ${datname}`)
        dropped.push(datname)
      } catch {
        // One database that will not drop is not a reason to abandon the rest.
      }
    }
    return dropped
  } finally {
    await maintenance.end()
  }
}

export async function createIsolatedDatabase(
  base: DbConfig = configFromEnv(),
): Promise<IsolatedDatabase> {
  const name = `${TEST_DATABASE_PREFIX}${Date.now()}_${randomBytes(6).toString('hex')}`

  // Connect to the maintenance database to issue CREATE DATABASE, which cannot
  // run inside a transaction or against the database being created.
  // Deliberately not managed: closePool() runs during drop(), and the
  // maintenance connection must outlive it to issue DROP DATABASE.
  const maintenance = new pg.Pool({
    host: base.host,
    port: base.port,
    database: base.database,
    user: base.ownerUser,
    password: base.ownerPassword,
    max: 1,
  })
  maintenance.on('error', (error) => {
    console.warn(JSON.stringify({ level: 'warn', message: 'maintenance pool error', error: String(error) }))
  })

  await maintenance.query(`CREATE DATABASE ${name}`)

  const config: DbConfig = { ...base, database: name }
  const admin = await connectAdmin(config)
  await applyMigrations(admin)

  return {
    config,
    admin,
    async drop(options = {}) {
      const report =
        options.onProblem ??
        ((message: string) =>
          console.warn(JSON.stringify({ level: 'warn', message: 'test database not dropped', detail: message })))
      try {
      // Close pooled application connections *first*. Terminating a backend
      // out from under an idle pooled client surfaces as a FATAL 57P01 on the
      // pool, which fails the run even though every test passed.
      await closePool()
      await admin.close()
      // Terminate anything still attached, or DROP DATABASE blocks.
      await maintenance.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name],
      )
        await maintenance.query(`DROP DATABASE IF EXISTS ${name}`)
      } catch (error) {
        // Reported, never thrown: the tests passed, and failing the suite in
        // `afterAll` would blame the wrong thing. Silence is what let these
        // accumulate (#158).
        report(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        await maintenance.end().catch(() => undefined)
      }
    },
  }
}
