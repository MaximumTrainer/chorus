import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

const root = join(import.meta.dirname, '..', '..', '..')
const read = (...path: string[]) => readFileSync(join(root, ...path), 'utf8')

const compose = parseYaml(read('deploy', 'docker-compose.yml')) as {
  services: Record<string, { image?: string; command?: string[] }>
}

/**
 * The value of one `key = "..."` line inside one `[table]` of a fly.toml.
 *
 * Deliberately not a TOML parser: these files use only flat string keys, and a
 * parser is a dependency (CLAUDE.md §7) for what a line match does exactly.
 * It fails loudly rather than returning undefined, so a renamed key cannot
 * make an assertion below vacuous.
 */
function flyValue(file: string, table: string, key: string): string {
  const text = read('deploy', 'fly', file)
  const section = text.split(/^\[/m).find((block) => block.startsWith(`${table}]`))
  if (!section) throw new Error(`${file} has no [${table}] table`)
  const line = section.split('\n').find((l) => l.trim().startsWith(`${key} =`))
  if (!line) throw new Error(`${file} [${table}] has no ${key}`)
  return JSON.parse(line.slice(line.indexOf('=') + 1).trim()) as string
}

/**
 * #144 — Chorus on Fly.io is the reference deployment, placed on Fly.
 *
 * Two descriptions of one system drift unless something holds them together:
 * a command changed in compose and not here is a deployment that runs
 * different code, or skips its migrations, with nothing failing until it is
 * live. So every command and image on Fly is asserted equal to its compose
 * counterpart, which CI already proves healthy on every pull request.
 */
describe('NFR-1 Fly.io deployment (#144)', () => {
  it.each(['api', 'worker', 'collab'])(
    'NFR-1: the Fly %s process runs exactly the command compose runs',
    (process) => {
      expect(flyValue('chorus.fly.toml', 'processes', process)).toBe(
        compose.services[process]?.command?.join(' '),
      )
    },
  )

  it('NFR-1: every release migrates first, with the same command as compose', () => {
    expect(flyValue('chorus.fly.toml', 'deploy', 'release_command')).toBe(
      compose.services.migrate?.command?.join(' '),
    )
  })

  it.each([
    ['postgres.fly.toml', 'postgres'],
    ['redis.fly.toml', 'redis'],
  ])('NFR-1: %s runs the image compose pins for %s', (file, service) => {
    expect(flyValue(file, 'build', 'image')).toBe(compose.services[service]?.image)
  })

  it('NFR-1: Fly Postgres carries the server settings compose starts Postgres with', () => {
    // The retrieval query plans depend on these (architecture.md §23.5).
    expect(flyValue('postgres.fly.toml', 'processes', 'db')).toBe(
      compose.services.postgres?.command?.join(' '),
    )
  })

  it('NFR-1: the public health check is readiness, as in compose', () => {
    expect(read('deploy', 'fly', 'chorus.fly.toml')).toMatch(/path = "\/readyz"/)
  })

  it('NFR-3: no secret is written into a Fly configuration', () => {
    for (const file of ['chorus.fly.toml', 'postgres.fly.toml', 'redis.fly.toml']) {
      const env = read('deploy', 'fly', file).split(/^\[/m).find((b) => b.startsWith('env]')) ?? ''
      expect(env, `${file} must set secrets with fly secrets set`).not.toMatch(
        /(PASSWORD|SECRET|MASTER_KEY|API_KEY)\w* =/,
      )
    }
  })
})
