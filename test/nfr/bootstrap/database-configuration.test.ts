import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, afterAll } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { closePool, configFromEnv, createManagedPool } from '@chorus/db'

/**
 * NFR-12 AC4 — `pnpm verify` and CI must reject the same changes.
 *
 * The divergence this exists to catch is not a missing flag in a script. It is
 * the *database* the suites are pointed at: `deploy/docker-compose.yml` starts
 * Postgres with planner settings chosen because the retrieval benchmark
 * measured the default abandoning the HNSW index and sorting the whole table.
 * A contributor running the reference stack gets those settings; a bare
 * Postgres does not.
 *
 * Nothing said so. The consequence was a query-plan assertion (BRAIN-4 AC5)
 * that passed on every developer machine and failed every night in CI for ten
 * days, reporting a scan nobody could reproduce — the failure mode NFR-12 AC4
 * names, arriving in the one suite slow enough that nobody watched it.
 *
 * So this asserts against the live server rather than against YAML: whatever
 * database this run is using must be configured the way the reference
 * deployment configures its own. The compose file is the single source of the
 * expected values, so tuning it is enough and there is nothing to keep in step.
 */

const root = join(import.meta.dirname, '..', '..', '..')
const compose = parseYaml(readFileSync(join(root, 'deploy', 'docker-compose.yml'), 'utf8'))

/**
 * The `-c key=value` settings the reference deployment starts Postgres with.
 *
 * Read out of the compose command rather than restated here: a second copy of
 * the expected value is a second thing to forget, which is the defect this
 * test is about.
 */
function referencePostgresSettings(): Map<string, string> {
  const command: string[] = compose.services?.postgres?.command ?? []
  const settings = new Map<string, string>()
  for (let i = 0; i < command.length; i += 1) {
    if (command[i] !== '-c') continue
    const [key, ...rest] = String(command[i + 1] ?? '').split('=')
    if (key && rest.length > 0) settings.set(key.trim(), rest.join('=').trim())
  }
  return settings
}

afterAll(async () => {
  await closePool()
})

describe('NFR-12 AC4 local and CI run against the same database configuration', () => {
  it('NFR-12 AC4: the reference deployment states the planner settings it depends on', () => {
    // Guards the test itself: if the compose command were reshaped, the loop
    // below would silently assert nothing and this suite would go quiet at
    // precisely the moment it was needed.
    expect(
      referencePostgresSettings().size,
      'deploy/docker-compose.yml no longer passes any `-c key=value` settings to postgres',
    ).toBeGreaterThan(0)
  })

  it('NFR-12 AC4: the database this run uses is configured like the reference deployment', async () => {
    const config = configFromEnv()
    const pool = createManagedPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.ownerUser,
      password: config.ownerPassword,
      max: 1,
      label: 'reference-configuration',
    })

    for (const [setting, expected] of referencePostgresSettings()) {
      const { rows } = await pool.query<Record<string, string>>(`SHOW ${setting}`)
      const actual = rows[0]?.[setting]
      const why =
        `${setting} is ${actual} here and ${expected} in the reference deployment — ` +
        `a query plan proved on one will not hold on the other`

      // Numerically where both sides are numbers, because `1.1` and `1.10` are
      // the same setting; by string otherwise, so a future non-numeric setting
      // is compared rather than turned into NaN and reported as a puzzle.
      if (Number.isFinite(Number(actual)) && Number.isFinite(Number(expected))) {
        expect(Number(actual), why).toBeCloseTo(Number(expected), 5)
      } else {
        expect(actual, why).toBe(expected)
      }
    }
  })
})
