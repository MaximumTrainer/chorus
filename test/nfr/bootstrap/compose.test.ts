import { readFileSync } from 'node:fs'
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

  it('NFR-1: every service reports health, so readiness is observable', () => {
    for (const [name, service] of Object.entries(services)) {
      expect(service.healthcheck, `${name} must declare a healthcheck`).toBeDefined()
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
