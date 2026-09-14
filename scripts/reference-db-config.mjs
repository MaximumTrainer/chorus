#!/usr/bin/env node
/**
 * Prints the `ALTER SYSTEM` statements that configure a Postgres the way the
 * reference deployment configures its own.
 *
 *   node scripts/reference-db-config.mjs | psql "$CHORUS_DATABASE_URL"
 *
 * `deploy/docker-compose.yml` starts Postgres with planner settings that were
 * measured, not guessed: at the default `random_page_cost` the planner
 * abandons the HNSW index and sorts the whole table, which the retrieval
 * benchmark asserts it does not do. A GitHub Actions service container cannot
 * be given a command, so CI ran with the defaults and the benchmark failed
 * every night on a plan nobody could reproduce locally (NFR-12 AC4).
 *
 * The settings are read out of the compose file rather than restated here, so
 * tuning the reference deployment is enough and there is no second copy to
 * forget. `test/nfr/bootstrap/database-configuration.test.ts` asserts the
 * server this suite runs against actually carries them.
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const compose = parseYaml(readFileSync(join(ROOT, 'deploy', 'docker-compose.yml'), 'utf8'))

const command = compose.services?.postgres?.command ?? []
const statements = []
for (let i = 0; i < command.length; i += 1) {
  if (command[i] !== '-c') continue
  const [key, ...rest] = String(command[i + 1] ?? '').split('=')
  if (!key || rest.length === 0) continue
  // Identifiers and values come from a file in this repository, but a setting
  // name is still interpolated into SQL: reject anything that is not one.
  if (!/^[a-z_]+$/.test(key.trim())) {
    console.error(`refusing to apply an unrecognised setting name: ${key}`)
    process.exit(1)
  }
  statements.push(`ALTER SYSTEM SET ${key.trim()} = '${rest.join('=').trim().replace(/'/g, "''")}';`)
}

// Silence here would leave CI on the defaults while reporting success, which
// is the failure this script exists to end.
if (statements.length === 0) {
  console.error('deploy/docker-compose.yml passes no `-c key=value` settings to postgres')
  process.exit(1)
}

for (const statement of statements) console.log(statement)
console.log('SELECT pg_reload_conf();')
