import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ulid, WorkflowDefinitionSchema } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createRetriever } from '@chorus/brain'
import { createApp } from '../../src/app.js'
import { createTurnRunner } from '../../src/chat-turn.js'
import {
  createFakeModelProvider,
  createRecordingMailer,
  createTestClient,
  type FakeModelProvider,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * CHAT-3 — every turn grounded, and the grounding shown.
 *
 * > This is the difference between a chat wrapper and a product workspace. It
 * > is also the primary defence against the agent's most damaging failure mode
 * > — confident invention — because a user who can see what the agent read can
 * > immediately tell whether an answer is grounded or guessed.
 *
 * The load-bearing word in AC1 is *exact*. A panel that re-runs retrieval when
 * you open it will usually agree with what the turn used, and will disagree
 * precisely when somebody is trying to work out why an answer was wrong — after
 * the index moved on. So the test moves the index on, deliberately, and then
 * opens the panel.
 */
describe('CHAT-3 grounded turns', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let models: FakeModelProvider

  const CHARTER = 'Never suggest a paid dependency.'

  const definition = WorkflowDefinitionSchema.parse({
    name: 'grounded-chat-turn',
    version: 1,
    steps: [
      // The symbol the fixture chunk actually contains. What retrieval *finds*
      // is BRAIN-4's requirement and has its own suite; this one is about the
      // panel showing exactly what the turn read.
      { id: 'gather', type: 'retrieve', query: 'parseInvoice' },
      { id: 'answer', type: 'model', prompt: 'reply.md' },
    ],
  })

  interface World {
    ada: SignedInUser
    workspaceId: string
    teamId: string
    sessionId: string
    repoId: string
  }

  async function world(): Promise<World> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Delivery')
    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    const teamId = teams[0]!.id
    await db.admin.execute(`UPDATE teams SET charter = $1 WHERE id = $2`, [CHARTER, teamId])

    // A connected, indexed repository. Seeded directly because connecting one
    // is INT-1's OAuth journey, and this is about what a turn reads.
    const integrationId = ulid()
    await db.admin.execute(
      `INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'github')`,
      [integrationId, workspace.id],
    )
    const repoId = ulid()
    await db.admin.execute(
      `INSERT INTO repositories (id, workspace_id, team_id, integration_id, provider, full_name)
       VALUES ($1, $2, $3, $4, 'github', $5)`,
      [repoId, workspace.id, teamId, integrationId, `acme/invoices-${repoId.slice(-6)}`],
    )
    const repo = { id: repoId }

    const started = (await (
      await ada.post(`/workspaces/${workspace.id}/teams/${teamId}/sessions`, {
        entryPoint: 'nothing',
      })
    ).json()) as { id: string }

    return {
      ada,
      workspaceId: workspace.id,
      teamId,
      sessionId: started.id,
      repoId: repo!.id,
    }
  }

  async function addChunk(w: World, input: { path: string; text: string }): Promise<void> {
    const fileId = ulid()
    await db.admin.execute(
      `INSERT INTO code_files (id, workspace_id, repository_id, path, lang, content_hash)
       VALUES ($1, $2, $3, $4, 'ts', $5)`,
      [fileId, w.workspaceId, w.repoId, input.path, ulid()],
    )
    await db.admin.execute(
      `INSERT INTO code_chunks
         (id, workspace_id, repository_id, file_id, text, line_start, line_end, symbol_name, embedding)
       VALUES ($1, $2, $3, $4, $5, 12, 40, 'parseInvoice', $6::vector)`,
      [
        ulid(),
        w.workspaceId,
        w.repoId,
        fileId,
        input.text,
        `[${models.embedText(input.text).join(',')}]`,
      ],
    )
  }

  async function readStream(response: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
    const body = await response.text()
    return body
      .split('\n\n')
      .filter((block) => block.trim() !== '')
      .map((block) => ({
        event: /^event:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? 'message',
        data: JSON.parse(/^data:\s*([\s\S]+)$/m.exec(block)?.[1]?.trim() ?? '{}') as Record<
          string,
          unknown
        >,
      }))
  }

  async function turn(w: World, text: string): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
    return readStream(
      await w.ada.post(`/workspaces/${w.workspaceId}/sessions/${w.sessionId}/messages`, { text }),
    )
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    models = createFakeModelProvider()
    // One retriever, shared by the turn that writes the bundle and the panel
    // that reads it — two would be two opinions about the same rows.
    const retriever = createRetriever(db.config, {
      models,
      embeddingModel: { provider: 'fake', model: 'fake-embed' },
    })
    client = createTestClient(
      createApp({
        dbConfig: db.config,
        mailer,
        retriever,
        turn: createTurnRunner(db.config, {
          models,
          modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
          definition,
          retriever,
        }),
      }),
      mailer,
    )
  })

  it('CHAT-3 AC1/AC3: the panel is the bundle the turn used, even after the index moves on', async () => {
    // Given an indexed repository and a question about the code
    const w = await world()
    await addChunk(w, { path: 'src/invoice.ts', text: 'export function parseInvoice() {}' })
    models.script({ chunks: ['It is in ', 'src/invoice.ts.'] })

    // When the turn runs
    const events = await turn(w, 'Where does the invoice parser live?')

    // Then the reader is told which bundle grounded it, as it happens
    const context = events.find((event) => event.event === 'context')
    expect(context, 'the turn was grounded and the reader must be told').toBeDefined()
    const bundleId = context!.data.bundleId as string

    // and the message records that bundle
    const session = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/sessions/${w.sessionId}`)
    ).json()) as {
      messages: Array<{ role: string; contextUsed: { bundleId?: string } | null }>
    }
    const assistant = session.messages.find((message) => message.role === 'assistant')
    expect(assistant!.contextUsed?.bundleId).toBe(bundleId)

    // Now the index moves on, as it does every time somebody pushes.
    await addChunk(w, { path: 'src/newer.ts', text: 'export function parseInvoice() { /* v2 */ }' })

    // When the panel is opened afterwards
    const panel = await w.ada.get(`/workspaces/${w.workspaceId}/context-bundles/${bundleId}`)
    expect(panel.status, await panel.clone().text()).toBe(200)
    const bundle = (await panel.json()) as {
      fragments: Array<{ path: string; lineStart: number; lineEnd: number; commitSha?: string }>
    }

    // Then it shows what the turn actually read — one fragment, not two. A
    // panel that re-ran retrieval would agree with the turn almost always, and
    // disagree exactly when somebody is working out why an answer was wrong.
    expect(bundle.fragments).toHaveLength(1)
    expect(bundle.fragments[0]).toMatchObject({
      path: 'src/invoice.ts',
      lineStart: 12,
      lineEnd: 40,
    })
  })

  it('CHAT-3 AC2: the charter is in the prompt whatever retrieval found', async () => {
    // Given a team with a charter and nothing indexed at all
    const w = await world()
    models.script({ chunks: ['Nothing to go on.'] })

    // When a turn runs
    await turn(w, 'What do you know?')

    // Then the charter is in what the model was sent, regardless of retrieval
    // returning nothing. It is the one input that is never a search result.
    const prompts = models.requests().map((request) => request.prompt)
    expect(prompts.some((prompt) => prompt.includes(CHARTER))).toBe(true)
  })

  it('CHAT-3 AC6: with nothing connected the panel is empty rather than absent', async () => {
    // Given a workspace with nothing indexed
    const w = await world()
    models.script({ chunks: ['I have nothing connected to go on.'] })

    // When a turn runs
    const events = await turn(w, 'What does the parser do?')

    // Then there is still a bundle, and it is honestly empty. No panel at all
    // would read as "grounding not applicable"; an empty one reads as "it had
    // nothing", which is the true and more useful statement.
    const bundleId = events.find((event) => event.event === 'context')!.data.bundleId as string
    const bundle = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/context-bundles/${bundleId}`)
    ).json()) as { fragments: unknown[] }
    expect(bundle.fragments).toEqual([])
  })
})
