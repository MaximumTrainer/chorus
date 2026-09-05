import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type TestClient } from '@chorus/testing'

/**
 * DOC-2 — the API answers a browser on another origin, and only the ones it was told about.
 *
 * The web app and the API are separate processes. Behind a single reverse
 * proxy they share an origin and none of this matters; in development, and in
 * any deployment that puts them on different hosts, the browser will not let
 * the page call the API at all without being told it may.
 *
 * The dangerous version of this fix is one line: reflect whatever `Origin`
 * arrives, or answer `*`. Either turns every authenticated route into one any
 * page on the internet can call with the reader's own session cookie. So the
 * allow-list is configuration, it is empty by default, and a deployment that
 * has not been told about a web origin refuses cross-origin requests rather
 * than guessing.
 */
describe('DOC-2 cross-origin access', () => {
  let db: IsolatedDatabase

  const WEB = 'http://127.0.0.1:3100'

  const appWith = (origins?: readonly string[]) => {
    const mailer = createRecordingMailer()
    return createTestClient(
      createApp({ dbConfig: db.config, mailer, ...(origins ? { webOrigins: origins } : {}) }),
      mailer,
    )
  }

  let client: TestClient

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    client = appWith([WEB])
  })

  it('DOC-2: an allow-listed origin is answered, by name and with credentials', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Documents')

    const response = await ada.request(`/workspaces/${workspace.id}`, {
      headers: { origin: WEB },
    })

    expect(response.status).toBe(200)
    // The origin by name, never `*`: a wildcard and credentials are mutually
    // exclusive in the specification precisely because the combination would
    // let any page use somebody's session.
    expect(response.headers.get('access-control-allow-origin')).toBe(WEB)
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
    expect(response.headers.get('access-control-allow-origin')).not.toBe('*')
  })

  it('DOC-2: an origin nobody allow-listed gets no such header', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Documents')

    const response = await ada.request(`/workspaces/${workspace.id}`, {
      headers: { origin: 'https://not-us.example' },
    })

    // Absent, not denied: without the header the browser refuses the response
    // itself, which is the enforcement. Reflecting the origin here is the
    // one-line version of this feature that hands every route to any page.
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('DOC-2: a preflight for an allow-listed origin succeeds without touching the route', async () => {
    const response = await client.anonymous().request(`/workspaces/anything/documents/x/collaboration-ticket`, {
      method: 'OPTIONS',
      headers: {
        origin: WEB,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })

    // A preflight carries no credentials and must not be authenticated — a 401
    // here means the browser never sends the real request, and the symptom is
    // a feature that silently does nothing.
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(WEB)
    expect(response.headers.get('access-control-allow-methods')).toContain('POST')
  })

  it('DOC-2: a deployment told about no web origin allows none', async () => {
    const plain = appWith()
    const ada = await plain.signedInUser()
    const workspace = await ada.createWorkspace('Documents')

    // The default is the safe one. A deployment that has not been configured
    // should not be quietly reachable from a page somebody else wrote.
    const response = await ada.request(`/workspaces/${workspace.id}`, {
      headers: { origin: WEB },
    })
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})
