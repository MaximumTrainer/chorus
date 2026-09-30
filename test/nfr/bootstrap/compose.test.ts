import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'

const root = join(import.meta.dirname, '..', '..', '..')
const compose = parseYaml(readFileSync(join(root, 'deploy', 'docker-compose.yml'), 'utf8'))
const services: Record<string, any> = compose.services ?? {}

/**
 * NFR-1 — Self-hosting.
 * The reference stack must stand up on one host with no mandatory SaaS
 * dependency except the model endpoint the operator chooses.
 */
describe('NFR-1 reference deployment', () => {
  it('NFR-1: the reference stack declares the infrastructure architecture.md §6 requires', () => {
    for (const required of ['postgres', 'redis', 'minio']) {
      expect(services[required], `compose must declare a ${required} service`).toBeDefined()
    }
  })

  it('NFR-1: postgres provides pgvector, because retrieval depends on it', () => {
    expect(services.postgres.image).toMatch(/pgvector/)
  })

  it('NFR-1: every image is pinned, so a deployment is reproducible', () => {
    for (const [name, service] of Object.entries(services)) {
      if (!service.image) continue
      expect(service.image, `${name} must pin a version`).toContain(':')
      expect(service.image, `${name} must not float on latest`).not.toMatch(/:latest$/)
    }
  })

  it('NFR-1: every long-running service reports health, so readiness is observable', () => {
    for (const [name, service] of Object.entries(services)) {
      // A one-shot job runs and exits, so it has no health to report. It is
      // identified by `restart: "no"` and held to the stronger guarantee below
      // instead.
      if (service.restart === 'no') continue
      expect(service.healthcheck, `${name} must declare a healthcheck`).toBeDefined()
    }
  })

  it('NFR-1: a one-shot job is waited on by everything that needs it to have run', () => {
    const oneShot = Object.entries(services)
      .filter(([, service]) => service.restart === 'no')
      .map(([name]) => name)

    for (const job of oneShot) {
      const dependents = Object.entries(services).filter(
        ([, service]) => service.depends_on?.[job],
      )
      // Otherwise `up --wait` reports a healthy stack while the job that had to
      // finish first is still running — an API serving requests against a
      // schema that does not exist yet.
      expect(dependents.length, `nothing waits for ${job}`).toBeGreaterThan(0)
      for (const [name, service] of dependents) {
        expect(
          service.depends_on[job].condition,
          `${name} must wait for ${job} to *complete*, not merely to start`,
        ).toBe('service_completed_successfully')
      }
    }
  })

  it('NFR-1 AC3: no service is configured against an external SaaS endpoint', () => {
    const rendered = JSON.stringify(compose)
    const urls = [...rendered.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase())
    const localHosts = ['localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal']
    for (const host of urls) {
      const isLocal = localHosts.includes(host) || !host.includes('.') // bare service names
      expect(isLocal, `compose points at external host "${host}"`).toBe(true)
    }
  })

  it('NFR-1: state is persisted in volumes, so a restart does not lose data', () => {
    for (const name of ['postgres', 'redis', 'minio']) {
      expect(services[name].volumes, `${name} must persist state`).toBeDefined()
    }
  })
})

/**
 * #182 — a variable the reference stack sets is one the code reads.
 *
 * Compose passed `CHORUS_DB_OWNER_*` to every process while the database
 * client read `CHORUS_DB_USER`/`CHORUS_DB_PASSWORD`. Nothing failed, because
 * the client's defaults happened to match Postgres's — so an operator setting
 * a real password got a database with it and services still connecting with
 * the default. A misspelt setting is silent by construction; this makes it
 * loud.
 */
describe('NFR-1 reference deployment configuration (#182)', () => {
  const sourceRoots = ['apps', 'packages'].flatMap((group) =>
    readdirSync(join(root, group)).map((name) => join(root, group, name, 'src')),
  )
  const read = (dir: string): string[] => {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return read(path)
      return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [readFileSync(path, 'utf8')] : []
    })
  }
  const source = sourceRoots.flatMap(read).join('\n')

  const set = Object.entries(services).flatMap(([name, service]) =>
    Object.keys((service.environment ?? {}) as Record<string, string>)
      .filter((key) => key.startsWith('CHORUS_'))
      .map((key) => [name, key] as const),
  )

  it('NFR-1: a reserved variable is still unread, so the exemption cannot outlive its reason', () => {
    for (const key of reserved) expect(source, `${key} now has a reader; drop it from reserved`).not.toContain(key)
  })

  it('NFR-1: the stack sets some CHORUS_ variables, so this gate is not vacuous', () => {
    expect(set.length).toBeGreaterThan(10)
  })

  // Declared ahead of their first reader, and named here so that stays a
  // decision: object storage is in the reference stack (architecture.md §5) but
  // nothing reads or writes a bucket yet. Remove an entry when its reader lands.
  const reserved = new Set(['CHORUS_S3_ENDPOINT', 'CHORUS_S3_ACCESS_KEY', 'CHORUS_S3_SECRET_KEY'])

  it.each(set.filter(([, key]) => !reserved.has(key)))('NFR-1: %s sets %s, and the code reads it', (_service, key) => {
    expect(source, `${key} is set by compose but read nowhere in apps/*/src or packages/*/src`).toContain(key)
  })
})
