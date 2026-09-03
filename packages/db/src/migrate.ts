import { connectAdmin, applyMigrations } from './admin.js'
import { configFromEnv } from './client.js'

/**
 * `pnpm db:migrate` (CLAUDE.md §9).
 *
 * Forward-only, by filename, and idempotent: every migration is written so that
 * re-running it is a no-op, which is what lets this be a boot step rather than
 * a thing someone remembers to run. A deployment that has to be migrated by
 * hand is one that eventually is not.
 *
 * Run as a one-shot before `api` starts, never by `api` itself: several API
 * replicas racing to apply the same DDL is a deadlock, and a stateless process
 * that mutates the schema on boot is no longer stateless.
 */
async function main(): Promise<void> {
  const config = configFromEnv()
  const admin = await connectAdmin(config)

  try {
    const applied = await applyMigrations(admin)
    console.warn(
      JSON.stringify({
        level: 'info',
        message: 'migrations applied',
        count: applied.length,
        database: config.database,
      }),
    )
  } finally {
    await admin.close()
  }
}

await main()
