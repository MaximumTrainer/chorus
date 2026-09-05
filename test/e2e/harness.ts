import { serve } from '@hono/node-server'
import { createApp } from '@chorus/api'
import { createCollabServer, type CollabServer } from '@chorus/collab'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createRecordingMailer, createTestClient } from '@chorus/testing'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The browser-journey harness (CLAUDE.md §4).
 *
 * Real Postgres, a real API, a real collaboration server, a real Next.js app —
 * and a faked mailer, because the one external thing a sign-in journey touches
 * is email. Everything else is the product.
 *
 * The API and the collaboration server run **in this process** rather than as
 * spawned commands. Not for speed: it is the only way to hold the mailer, and
 * the mailer is what makes a real sign-up flow drivable without a mail server.
 * A journey that skipped sign-in by writing a session row would test a page
 * nobody can reach.
 */

export interface BrowserCookie {
  readonly name: string
  readonly value: string
  readonly domain: string
  readonly path: string
}

export interface HarnessState {
  readonly webUrl: string
  readonly apiUrl: string
  readonly collabUrl: string
  readonly workspaceId: string
  readonly teamId: string
  readonly documentId: string
  readonly people: ReadonlyArray<{
    readonly name: string
    readonly email: string
    readonly cookies: readonly BrowserCookie[]
  }>
}

/**
 * A `set-cookie` header as the browser would hold it.
 *
 * Only the name and value: the attributes describe how a browser should have
 * stored it, and re-asserting `Secure` or a `SameSite` on an injected cookie is
 * how a session silently fails to be sent over plain HTTP in a test.
 */
function asCookies(header: string): BrowserCookie[] {
  return header
    .split(/,(?=[^;]+?=)/)
    .map((cookie) => cookie.split(';')[0]?.trim() ?? '')
    .filter((pair) => pair.includes('='))
    .map((pair) => {
      const index = pair.indexOf('=')
      return {
        name: pair.slice(0, index),
        value: pair.slice(index + 1),
        domain: '127.0.0.1',
        path: '/',
      }
    })
}

/** Where globalSetup leaves what the tests need. Read, never guessed. */
export const STATE_PATH = join(import.meta.dirname, '.harness.json')

/**
 * Fixed ports, deliberately.
 *
 * Playwright starts the web server *before* global setup runs, so the Next
 * process is already alive by the time the API binds. It therefore cannot be
 * told an ephemeral port — it has to be given the address in advance and find
 * something there when a request arrives. A conflict here fails loudly at bind
 * time, which is a better outcome than a test suite that silently talks to
 * whatever else is listening.
 */
export const E2E_API_PORT = 3200
export const E2E_COLLAB_PORT = 3201

let db: IsolatedDatabase | undefined
let collab: CollabServer | undefined
let api: { close(callback: () => void): void } | undefined

export default async function globalSetup(): Promise<() => Promise<void>> {
  db = await createIsolatedDatabase()

  const mailer = createRecordingMailer()
  // The browser is on another origin here, as it is in any deployment that
  // does not put both behind one proxy.
  const app = createApp({
    dbConfig: db.config,
    mailer,
    webOrigins: ['http://127.0.0.1:3100'],
  })

  const listening = serve({ fetch: app.fetch, port: E2E_API_PORT, hostname: '127.0.0.1' })
  api = listening
  const apiUrl = `http://127.0.0.1:${E2E_API_PORT}`

  collab = await createCollabServer({ dbConfig: db.config, port: E2E_COLLAB_PORT })

  // The real sign-up, verification and sign-in flow, driven through the same
  // harness the API suites use — so the session the browser carries is one the
  // product actually issues.
  const client = createTestClient(app, mailer)
  const ada = await client.signedInUser(undefined, 'Ada')
  const workspace = await ada.createWorkspace('Documents')
  const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
    id: string
  }>
  const document = (await (
    await ada.post(`/workspaces/${workspace.id}/teams/${teams[0]!.id}/documents`, {
      type: 'prd',
      title: 'Invoice splitting',
    })
  ).json()) as { id: string }

  // A second person, in the same workspace, with a different name — two people
  // both called "Test User" would make every assertion about whose cursor is
  // whose pass whichever one the page happened to show.
  const grace = await client.memberWithRole(ada, workspace.id, 'member', undefined, 'Grace')

  const state: HarnessState = {
    webUrl: 'http://127.0.0.1:3100',
    apiUrl,
    collabUrl: `ws://127.0.0.1:${E2E_COLLAB_PORT}`,
    workspaceId: workspace.id,
    teamId: teams[0]!.id,
    documentId: document.id,
    people: [
      { name: 'Ada', email: ada.email, cookies: asCookies(ada.cookie) },
      { name: 'Grace', email: grace.email, cookies: asCookies(grace.cookie) },
    ],
  }

  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8')

  return async () => {
    await collab?.stop()
    await new Promise<void>((resolve) => api?.close(() => resolve()))
    await db?.drop()
  }
}
