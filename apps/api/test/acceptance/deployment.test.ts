import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from '@chorus/core'
import { createIsolatedDatabase, type DbConfig, type IsolatedDatabase } from '@chorus/db'
import { createAppFromEnvironment } from '../../src/compose.js'

/**
 * NFR-1 AC1, AC2 — a deployment is the environment, and nothing else.
 *
 * Every other acceptance test builds the app by hand and hands it a recording
 * mailer, a fake model and a retriever. The process a deployment actually runs
 * builds it from `CHORUS_*` variables alone, and that composition had no test:
 * it passed no mail transport, so `/auth/*` was never mounted and nobody could
 * sign in to a running system. These tests build the app the way `main.ts`
 * does, and drive it as the first person to reach a fresh install would.
 */
describe('NFR-1 a deployment configured only from its environment', () => {
  let db: IsolatedDatabase

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  /** The variables an operator would set for this database. */
  const environmentFor = (config: DbConfig): NodeJS.ProcessEnv => ({
    CHORUS_DB_HOST: config.host,
    CHORUS_DB_PORT: String(config.port),
    CHORUS_DB_NAME: config.database,
    CHORUS_DB_USER: config.ownerUser,
    CHORUS_DB_PASSWORD: config.ownerPassword,
    CHORUS_DB_APP_USER: config.appUser,
    CHORUS_DB_APP_PASSWORD: config.appPassword,
    CHORUS_BASE_URL: 'http://chorus.test',
  })

  const json = (body: unknown, cookie?: string): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })

  it('NFR-1 AC1: with no mail transport configured, the first person signs up through the link in the log', async () => {
    // Given a fresh deployment with only a database configured, as `docker compose up` gives
    const lines: string[] = []
    const app = createAppFromEnvironment(environmentFor(db.config), { log: (line) => lines.push(line) })

    // When the first person signs up
    const email = 'first@example.test'
    const password = 'correct-horse-battery-staple'
    const signUp = await app.request('/auth/sign-up/email', json({ email, password, name: 'First' }))
    expect(signUp.status, await signUp.clone().text()).toBe(200)

    // Then the verification link they need is in the server's log, addressed to them
    const entry = lines
      .map((line) => JSON.parse(line) as { to?: string; text?: string })
      .find((logged) => logged.to === email)
    expect(entry, 'the verification link must reach the operator').toBeDefined()
    const link = /https?:\/\/\S+/.exec(entry!.text ?? '')?.[0]
    expect(link).toMatch(/^http:\/\/chorus\.test\/auth\/verify-email\?token=/)

    // And following it lets them sign in and create the first workspace
    await app.request(link!, { redirect: 'manual' })
    const signIn = await app.request('/auth/sign-in/email', json({ email, password }))
    const cookie = signIn.headers.get('set-cookie')
    expect(cookie, await signIn.clone().text()).toBeTruthy()

    const workspace = await app.request('/workspaces', json({ name: 'First workspace' }, cookie!))
    expect(workspace.status, await workspace.clone().text()).toBe(201)
  })

  /**
   * A local model endpoint, as Ollama or vLLM would serve it: an
   * OpenAI-compatible HTTP server on this host, reached over the network the
   * way the deployment reaches one. It answers embeddings with a fixed vector
   * and records what it was asked.
   */
  async function aLocalModelEndpoint(): Promise<{ baseUrl: string; requests: Array<{ path: string; body: { model?: string } }>; close(): Promise<void> }> {
    const requests: Array<{ path: string; body: { model?: string } }> = []
    const server: Server = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
      request.on('end', () => {
        const body = (raw ? JSON.parse(raw) : {}) as { model?: string; input?: string[] }
        requests.push({ path: request.url ?? '', body })
        if (request.url?.endsWith('/embeddings')) {
          const data = (body.input ?? []).map((_, index) => ({
            index,
            embedding: Array.from({ length: 1536 }, (__, i) => (i === 0 ? 1 : 0)),
          }))
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }))
          return
        }
        response.writeHead(404).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    return {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      requests,
      close: () => new Promise((resolve) => server.close(() => resolve())),
    }
  }

  /** The shipped example tiers, each pointed at a model the local endpoint serves. */
  const localTiers = (): string => {
    const example = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'deploy', 'model-tiers.example.json'), 'utf8'),
    ) as Record<string, unknown>
    // Keys starting `_` are commentary and alternative profiles, not tiers.
    for (const key of Object.keys(example)) if (key.startsWith('_')) delete example[key]
    for (const [tier, candidates] of Object.entries(example)) {
      example[tier] = (candidates as Array<Record<string, unknown>>).map((candidate) => ({
        ...candidate,
        provider: 'openai-compatible',
        model: `local-${tier}`,
      }))
    }
    return JSON.stringify(example)
  }

  /** Signs up through the logged link, as the first test proves possible, and returns a session cookie. */
  async function firstPerson(app: ReturnType<typeof createAppFromEnvironment>, lines: string[], email: string) {
    const password = 'correct-horse-battery-staple'
    await app.request('/auth/sign-up/email', json({ email, password, name: 'First' }))
    const entry = lines
      .map((line) => JSON.parse(line) as { to?: string; text?: string })
      .find((logged) => logged.to === email)
    await app.request(/https?:\/\/\S+/.exec(entry!.text!)![0], { redirect: 'manual' })
    const cookie = (await app.request('/auth/sign-in/email', json({ email, password }))).headers.get('set-cookie')!
    return cookie
  }

  it('NFR-1 AC2: with only a local model endpoint configured, search finds what the workspace holds', async () => {
    // Given a deployment whose only model is a local OpenAI-compatible endpoint
    const local = await aLocalModelEndpoint()
    try {
      const lines: string[] = []
      const app = createAppFromEnvironment(
        { ...environmentFor(db.config), CHORUS_MODEL_BASE_URL: local.baseUrl, CHORUS_MODEL_TIERS: localTiers() },
        { log: (line) => lines.push(line) },
      )
      const cookie = await firstPerson(app, lines, 'searcher@example.test')
      const workspace = (await (await app.request('/workspaces', json({ name: 'Local' }, cookie))).json()) as { id: string }
      const [team] = (await (
        await app.request(`/workspaces/${workspace.id}/teams`, { headers: { cookie } })
      ).json()) as Array<{ id: string }>
      const created = await app.request(
        `/workspaces/${workspace.id}/teams/${team!.id}/tasks`,
        json({ title: 'Reconcile the ledger nightly' }, cookie),
      )
      expect(created.status, await created.clone().text()).toBe(201)
      // and a repository the worker has indexed, with the same embed-tier vector
      const integrationId = ulid()
      const repositoryId = ulid()
      const fileId = ulid()
      await db.admin.execute(`INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'github')`, [
        integrationId,
        workspace.id,
      ])
      await db.admin.execute(
        `INSERT INTO repositories (id, workspace_id, team_id, integration_id, provider, full_name)
         VALUES ($1, $2, $3, $4, 'github', 'acme/ledger')`,
        [repositoryId, workspace.id, team!.id, integrationId],
      )
      await db.admin.execute(
        `INSERT INTO code_files (id, workspace_id, repository_id, path, lang, content_hash)
         VALUES ($1, $2, $3, 'src/settle.ts', 'ts', $1)`,
        [fileId, workspace.id, repositoryId],
      )
      await db.admin.execute(
        `INSERT INTO code_chunks
           (id, workspace_id, repository_id, file_id, text, line_start, line_end, symbol_name, embedding)
         VALUES ($1, $2, $3, $4, 'export function settleAccounts() {}', 1, 3, 'settleAccounts', $5::vector)`,
        [ulid(), workspace.id, repositoryId, fileId, `[${Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`],
      )

      // When they search for it
      const response = await app.request(
        `/workspaces/${workspace.id}/teams/${team!.id}/search`,
        json({ query: 'reconcile ledger' }, cookie),
      )

      // Then it is found, cited as the task it is
      expect(response.status, await response.clone().text()).toBe(200)
      const bundle = (await response.json()) as { fragments: Array<{ kind: string; title?: string }> }
      expect(bundle.fragments).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'task', title: 'Reconcile the ledger nightly' })]),
      )
      // and the code found by meaning alone, because the query was embedded by
      // the local endpoint with the embed tier's model
      expect(bundle.fragments).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'code' })]))
      expect(local.requests.some((r) => r.path.endsWith('/embeddings') && r.body.model === 'local-embed')).toBe(true)
    } finally {
      await local.close()
    }
  })
})
