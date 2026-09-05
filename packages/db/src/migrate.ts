import { connectAdmin, applyMigrations } from './admin.js'
import { configFromEnv } from './client.js'

/**
 * `pnpm db:migrate` (CLAUDE.md §9).
 *
 * Forward-only, by filename, and idempotent *as a whole*: a `schema_migrations`
 * ledger records what this database has already seen, so running it again
 * applies only what is new. That is what lets this be a boot step rather than a
 * thing someone remembers to run — a deployment that has to be migrated by hand
 * is one that eventually is not.
 *
 * The individual files are not required to be re-runnable, and must not be
 * edited once applied: the runner refuses a file whose checksum has changed
 * rather than skipping it (NFR-1 AC5).
 *
 * Run as a one-shot before `api` starts, never by `api` itself: several API
 * replicas racing to apply the same DDL is a deadlock, and a stateless process
 * that mutates the schema on boot is no longer stateless.
 */
async function main(): Promise<void> {
  const config = configFromEnv()
  const admin = await connectAdmin(config)

  // The one-time adoption of a database that predates the ledger. Deliberately
  // explicit — as a flag or an environment variable, since the compose stack
  // has no argv to pass — because it asserts something the runner cannot check:
  // that this schema is current.
  const baseline =
    process.argv.includes('--baseline') || process.env.CHORUS_DB_BASELINE === '1' ||
    process.env.CHORUS_DB_BASELINE === 'true'

  try {
    const applied = await applyMigrations(admin, { baseline })
    console.warn(
      JSON.stringify({
        level: 'info',
        message: baseline && applied.length === 0 ? 'migrations baselined' : 'migrations applied',
        count: applied.length,
        database: config.database,
      }),
    )
  } finally {
    await admin.close()
  }
}

await main()
