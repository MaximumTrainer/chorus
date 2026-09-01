import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'

/**
 * NFR-5 AC5 — health endpoints are accurate.
 *
 * Liveness and readiness answer different questions, and conflating them is the
 * classic operational bug: a process that is alive but cannot reach its
 * database will be left in a load balancer's rotation, serving errors, if
 * readiness merely reports that the process is running.
 */
describe('NFR-5 AC5 health endpoints', () => {
  let db: IsolatedDatabase

  beforeAll(async () => {
    // A database of this file's own, so the suite is parallel-safe (CLAUDE.md §5).
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('NFR-5 AC5: liveness reports process health without touching dependencies', async () => {
    // Deliberately pointed at an unreachable database: liveness must not care.
    const app = createApp({ checkReadiness: async () => ({ ready: false, reason: 'db down' }) })
    const response = await app.request('/healthz')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok' })
  })

  it('NFR-5 AC5: readiness reports not-ready with a reason when a dependency is unreachable', async () => {
    const app = createApp({
      checkReadiness: async () => ({ ready: false, reason: 'database unreachable' }),
    })
    const response = await app.request('/readyz')

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      status: 'not_ready',
      reason: 'database unreachable',
    })
  })

  it('NFR-5 AC5: readiness reports not-ready when migrations are pending', async () => {
    const app = createApp({
      checkReadiness: async () => ({ ready: false, reason: 'migrations pending' }),
    })
    const response = await app.request('/readyz')

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ reason: 'migrations pending' })
  })

  it('NFR-5 AC5: readiness reports ready when dependencies are reachable and the schema is current', async () => {
    const app = createApp({ dbConfig: db.config })
    const response = await app.request('/readyz')
    const body = await response.json()

    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body).toMatchObject({ status: 'ready' })
  })
})

/**
 * architecture.md §18 — errors are RFC 9457 problem details with a stable type
 * URI per error class, so a consumer can branch on the kind of failure without
 * parsing prose.
 */
describe('API error contract', () => {
  it('renders an unknown route as a problem document, not an HTML page', async () => {
    const app = createApp()
    const response = await app.request('/no-such-route')

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(await response.json()).toMatchObject({
      type: 'https://chorus.dev/problems/not_found',
      status: 404,
    })
  })

  it('maps a thrown AppError to its declared status and type', async () => {
    const app = createApp()
    const response = await app.request('/__test/forbidden')

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      type: 'https://chorus.dev/problems/forbidden',
      status: 403,
    })
  })

  it('never leaks an unexpected error message to the client', async () => {
    const app = createApp()
    const response = await app.request('/__test/boom')
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(500)
    // The cause is logged server-side; the client gets a stable, generic shape.
    expect(JSON.stringify(body)).not.toContain('secret internal detail')
    expect(body).toMatchObject({ status: 500 })
  })

  it('stamps every response with a request id, so a report maps to a log line', async () => {
    const app = createApp()
    const response = await app.request('/healthz')
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })
})
