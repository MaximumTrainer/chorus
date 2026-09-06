import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { configFromEnv, createIsolatedDatabase, sweepStaleTestDatabases } from '../../src/index.js'

/**
 * NFR-12 AC4 — an interrupted run must not poison the next one (#158).
 *
 * `createIsolatedDatabase` gives each test file a database of its own and drops
 * it afterwards. When a run is interrupted, or a drop fails, the database
 * stays — and nothing notices, because the next run invents a new name.
 *
 * The cost is not tidiness. Measured on one machine, eleven stale databases
 * turned a 30 s suite into 3043 s, failing as a 120 s timeout on an arbitrary
 * unrelated test. That is the worst shape a failure can take: it points at
 * whatever was unlucky rather than at the cause, it moves between runs, and it
 * invites exactly the retry CLAUDE.md §7 forbids.
 *
 * So the name carries the moment it was created, and a sweep can tell a
 * database that was abandoned from one a parallel run is using right now.
 */
describe('NFR-12 isolated test databases', () => {
  const base = configFromEnv()
  let maintenance: pg.Pool

  const exists = async (name: string): Promise<boolean> => {
    const { rows } = await maintenance.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name])
    return rows.length === 1
  }

  beforeAll(() => {
    maintenance = new pg.Pool({
      host: base.host,
      port: base.port,
      database: base.database,
      user: base.ownerUser,
      password: base.ownerPassword,
      max: 1,
    })
  })

  afterAll(async () => {
    await maintenance.end()
  })

  it('NFR-12: a database names the moment it was created, so age is readable without a catalogue', async () => {
    const db = await createIsolatedDatabase()
    try {
      // Postgres records no creation time for a database, so it has to be in
      // the name or it does not exist. Without it a sweep can only choose
      // between dropping nothing and dropping databases a parallel run is
      // still using.
      expect(db.config.database).toMatch(/^chorus_test_\d{13}_[0-9a-f]+$/)
    } finally {
      await db.drop()
    }
  })

  it('NFR-12: the sweep drops an abandoned database and leaves a live one alone', async () => {
    // Given a database abandoned an hour ago, and one created just now
    const abandoned = `chorus_test_${Date.now() - 60 * 60 * 1000}_deadbeef`
    await maintenance.query(`CREATE DATABASE ${abandoned}`)
    const live = await createIsolatedDatabase()

    try {
      // When stale databases older than ten minutes are swept
      const dropped = await sweepStaleTestDatabases({ olderThanMs: 10 * 60 * 1000, config: base })

      // Then the abandoned one is gone
      expect(dropped).toContain(abandoned)
      expect(await exists(abandoned)).toBe(false)

      // and the one a run is using right now survives. Age rather than a
      // blanket drop, because two suites run in parallel here and a sweep that
      // took the others with it would be a worse bug than the leak.
      expect(dropped).not.toContain(live.config.database)
      expect(await exists(live.config.database)).toBe(true)
    } finally {
      await live.drop()
      await maintenance.query(`DROP DATABASE IF EXISTS ${abandoned}`)
    }
  })

  it('NFR-12: a failed drop is reported rather than swallowed', async () => {
    // Given a database that has already been removed behind the harness's back
    const db = await createIsolatedDatabase()
    const warnings: string[] = []

    // When the drop cannot do its job
    await db.drop({ onProblem: (message) => warnings.push(message) })
    await db.drop({ onProblem: (message) => warnings.push(message) })

    // Then the second attempt says so, naming the database. A silent failure
    // here is what let eleven of these accumulate unnoticed.
    expect(warnings.join(' ')).toContain(db.config.database)
  })
})
