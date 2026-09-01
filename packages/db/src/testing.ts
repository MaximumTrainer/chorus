import { Pool } from 'pg'
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
  /** Drop the database and close every connection to it. */
  drop(): Promise<void>
}

export async function createIsolatedDatabase(
  base: DbConfig = configFromEnv(),
): Promise<IsolatedDatabase> {
  const name = `chorus_test_${randomBytes(8).toString('hex')}`

  // Connect to the maintenance database to issue CREATE DATABASE, which cannot
  // run inside a transaction or against the database being created.
  const maintenance = new Pool({
    host: base.host,
    port: base.port,
    database: base.database,
    user: base.ownerUser,
    password: base.ownerPassword,
    max: 1,
  })

  await maintenance.query(`CREATE DATABASE ${name}`)

  const config: DbConfig = { ...base, database: name }
  const admin = await connectAdmin(config)
  await applyMigrations(admin)

  return {
    config,
    admin,
    async drop() {
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
      await maintenance.end()
    },
  }
}
