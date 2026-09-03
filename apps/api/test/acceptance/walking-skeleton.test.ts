import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createIndexer } from '@chorus/indexer'
import { createFakeModelProvider, type FakeModelProvider } from '@chorus/testing'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type TestClient } from '@chorus/testing'

/**
 * WP-0.6 — the walking skeleton, and Phase 0's exit criterion.
 *
 * > A user signs up, creates a workspace, connects a repository, and asks a
 * > question about the code — receiving a streamed answer citing real files at
 * > a real commit.
 *
 * This is the *whole* journey, through real public entry points, and its
 * purpose is to prove every layer connects: auth, workspaces, teams,
 * repositories, the index, retrieval, the model layer and streaming. It is not
 * a test of any of them in depth — each has its own suite — it is a test that
 * they are joined up.
 *
 * The code under test is deliberately disposable (plan.md §2.5) and Phase 1's
 * exit criteria require it to be deleted. The test, notably, is *not*
 * disposable: the same journey has to keep passing against the real agent
 * runtime, which is what makes deleting the skeleton safe.
 *
 * Indexing is performed here by the harness rather than through the API,
 * standing in for the worker that WP-0.6 does not include. Everything else the
 * user does goes through HTTP exactly as they would do it.
 */
describe('WP-0.6 walking skeleton', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let models: FakeModelProvider
  const FIXTURES = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'packages',
    'indexer',
    'test',
    'fixtures',
  )
  const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 180_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    models = createFakeModelProvider()
    client = createTestClient(createApp({ dbConfig: db.config, mailer, models }), mailer)
  })

  /** Everything up to and including a repository with an index behind it. */
  async function connectedAndIndexed(fixture = 'nextjs-app') {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Walking Skeleton')
    const [team] = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>

    const [integration] = await db.admin.query<{ id: string }>(
      `INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'github') RETURNING id`,
      [`int${Date.now()}${Math.floor(Math.random() * 10000)}`, workspace.id],
    )

    const linked = await ada.post(`/workspaces/${workspace.id}/teams/${team!.id}/repositories`, {
      integrationId: integration!.id,
      provider: 'github',
      fullName: 'acme/widgets',
    })
    expect(linked.status, await linked.clone().text()).toBe(201)
    const repository = (await linked.json()) as { id: string }

    // The worker's job, done by the harness: WP-0.6 does not include one.
    const indexer = await createIndexer(db.config, {
      embed: async (texts) => texts.map((text) => models.embedText(text)),
      embeddingModel: 'fake-embed-v1',
    })
    await db.admin.execute(`DELETE FROM code_files WHERE workspace_id = $1`, [workspace.id])
    const run = await indexer.index({
      workspaceId: workspace.id,
      repositoryId: repository!.id,
      workingCopy: join(FIXTURES, fixture),
      commitSha: COMMIT,
    })
    expect(run.status).toBe('succeeded')

    return { ada, workspaceId: workspace.id, repositoryId: repository!.id }
  }

  /** Reads an SSE body into its events. */
  async function readStream(response: Response): Promise<Array<{ event: string; data: unknown }>> {
    const body = await response.text()
    return body
      .split('\n\n')
      .filter((block) => block.trim() !== '')
      .map((block) => {
        const event = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? 'message'
        const data = /^data:\s*([\s\S]+)$/m.exec(block)?.[1]?.trim() ?? ''
        return { event, data: data === '' ? null : JSON.parse(data) }
      })
  }

  it('WP-0.6: Phase 0 exit — a question about connected code is answered, streamed, with citations', async () => {
    const { ada, workspaceId } = await connectedAndIndexed()

    // The model is scripted rather than called: never a real provider from a
    // test (CLAUDE.md §4).
    models.script({
      chunks: ['The settings page ', 'is rendered by ', 'app/settings/page.tsx.'],
    })

    const response = await ada.post(`/workspaces/${workspaceId}/ask`, {
      question: 'Where is the settings page rendered?',
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const events = await readStream(response)
    const kinds = events.map((event) => event.event)

    // Streamed, not delivered whole: the point of the skeleton is that the
    // streaming path works end to end.
    expect(kinds.filter((kind) => kind === 'token').length).toBeGreaterThan(1)
    expect(kinds).toContain('context')
    expect(kinds.at(-1)).toBe('done')

    const answer = events
      .filter((event) => event.event === 'token')
      .map((event) => (event.data as { text: string }).text)
      .join('')
    expect(answer).toContain('app/settings/page.tsx')

    // Citing *real files at a real commit* is the half of the criterion that
    // makes the answer checkable rather than merely fluent.
    const context = events.find((event) => event.event === 'context')!.data as {
      commitSha: string
      citations: Array<{ path: string; lineStart: number; lineEnd: number }>
    }
    expect(context.commitSha).toBe(COMMIT)
    expect(context.citations.length).toBeGreaterThan(0)

    const indexedPaths = (
      await db.admin.query<{ path: string }>(`SELECT path FROM code_files WHERE workspace_id = $1`, [
        workspaceId,
      ])
    ).map((row) => row.path)
    for (const citation of context.citations) {
      // A citation naming a file that is not in the index is one a reader
      // cannot open, which is the failure that makes citations worthless.
      expect(indexedPaths, `${citation.path} must be a real indexed file`).toContain(citation.path)
      expect(citation.lineStart).toBeGreaterThanOrEqual(1)
      expect(citation.lineEnd).toBeGreaterThanOrEqual(citation.lineStart)
    }
  })

  it('WP-0.6: the retrieved context is what the model was actually given', async () => {
    const { ada, workspaceId } = await connectedAndIndexed()
    models.script({ chunks: ['Answer.'] })

    const events = await readStream(
      await ada.post(`/workspaces/${workspaceId}/ask`, { question: 'What renders the home page?' }),
    )
    const context = events.find((event) => event.event === 'context')!.data as {
      citations: Array<{ path: string }>
    }

    // The context panel must be exact against what was sent, or it is
    // decoration. CHAT-3 makes this a requirement in Phase 1; asserting it now
    // means the skeleton cannot establish the habit of lying about it.
    const [request] = models.requests()
    for (const citation of context.citations) {
      expect(request!.prompt, `${citation.path} was shown but not sent`).toContain(citation.path)
    }
  })

  it('WP-0.6: a workspace with no indexed code says so rather than inventing an answer', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Nothing Indexed')
    models.script({ chunks: ['I should not be called.'] })

    const response = await ada.post(`/workspaces/${workspace.id}/ask`, {
      question: 'Where is the settings page?',
    })
    const events = await readStream(response)

    // Answering from a model's general knowledge when we retrieved nothing is
    // how a grounded product becomes a plausible one.
    const context = events.find((event) => event.event === 'context')!.data as {
      citations: unknown[]
    }
    expect(context.citations).toHaveLength(0)
    expect(models.requests(), 'no retrieval means nothing to answer from').toHaveLength(0)
    expect(events.at(-1)!.event).toBe('done')
  })

  it("WP-0.6: one workspace's question never retrieves another's code", async () => {
    const mine = await connectedAndIndexed('nextjs-app')
    const theirs = await connectedAndIndexed('sveltekit')
    models.script({ chunks: ['Answer.'] })

    const events = await readStream(
      await theirs.ada.post(`/workspaces/${theirs.workspaceId}/ask`, {
        question: 'Where is the settings page rendered?',
      }),
    )
    const context = events.find((event) => event.event === 'context')!.data as {
      citations: Array<{ path: string }>
    }

    // The tenancy boundary, asserted at the last place it could leak: retrieval
    // reads across every chunk in the database, and a missing predicate here
    // would surface another workspace's source in an answer.
    //
    // Compared against what *this* workspace indexed rather than by path shape:
    // both fixtures contain a package.json, so a prefix check would pass while
    // proving nothing.
    const theirFiles = (
      await db.admin.query<{ path: string }>(`SELECT path FROM code_files WHERE workspace_id = $1`, [
        theirs.workspaceId,
      ])
    ).map((row) => row.path)

    for (const citation of context.citations) {
      expect(theirFiles, `${citation.path} is not a file this workspace indexed`).toContain(
        citation.path,
      )
    }

    // And specifically not the other workspace's — a path that exists only in
    // the fixture the *other* workspace indexed.
    expect(context.citations.map((c) => c.path)).not.toContain('app/settings/page.tsx')
    expect(mine.workspaceId).not.toBe(theirs.workspaceId)
  })

  it('WP-0.6: a member may ask; an unauthenticated caller may not', async () => {
    const { workspaceId } = await connectedAndIndexed()

    const anonymous = await client.anonymous().post(`/workspaces/${workspaceId}/ask`, {
      question: 'Where is the settings page?',
    })
    expect(anonymous.status).toBe(401)
  })

  it('WP-0.6: a model failure ends the stream with an error event, not a hang', async () => {
    const { ada, workspaceId } = await connectedAndIndexed()
    models.script({ failWith: 'the provider is unavailable' })

    const events = await readStream(
      await ada.post(`/workspaces/${workspaceId}/ask`, { question: 'Where is the settings page?' }),
    )

    // A stream that stops without saying why leaves a reader waiting forever.
    expect(events.at(-1)!.event).toBe('error')
  })

  it('WP-0.6: a question is required', async () => {
    const { ada, workspaceId } = await connectedAndIndexed()
    const response = await ada.post(`/workspaces/${workspaceId}/ask`, {})
    expect(response.status).toBe(400)
  })
})
