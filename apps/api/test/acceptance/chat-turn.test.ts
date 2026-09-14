import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { WorkflowDefinitionSchema } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
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
 * CHAT-2 — the turn, streamed.
 *
 * > Streaming is not decoration: first-token latency under two seconds is what
 * > makes the agent feel like a collaborator rather than a form submission.
 * > Showing tool calls inline is what makes it trustworthy — the user sees it
 * > searching the codebase rather than wondering.
 *
 * So the assertions are about what a reader receives *while the turn is still
 * running*, and about what is left behind afterwards. A route that assembled
 * the whole answer and sent it in one frame would satisfy a naive reading of
 * "the response contains the reply" and none of the requirement.
 */
describe('CHAT-2 streaming chat', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let models: FakeModelProvider

  /** A workflow that calls a tool and then a model, which is the shape AC2 is about. */
  const definition = WorkflowDefinitionSchema.parse({
    name: 'chat-turn',
    version: 1,
    tools: ['look_up'],
    steps: [
      { id: 'look', type: 'tool', tool: 'look_up' },
      { id: 'answer', type: 'model', prompt: 'reply.md' },
    ],
  })

  async function session(): Promise<{
    ada: SignedInUser
    workspaceId: string
    teamId: string
    sessionId: string
  }> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Delivery')
    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    const started = (await (
      await ada.post(`/workspaces/${workspace.id}/teams/${teams[0]!.id}/sessions`, {
        entryPoint: 'idea',
        seed: 'Split the invoice parser',
      })
    ).json()) as { id: string }

    return { ada, workspaceId: workspace.id, teamId: teams[0]!.id, sessionId: started.id }
  }

  /** Reads an SSE body into its events, keeping order and ids. */
  async function readStream(
    response: Response,
  ): Promise<Array<{ id: string | undefined; event: string; data: Record<string, unknown> }>> {
    const body = await response.text()
    return body
      .split('\n\n')
      .filter((block) => block.trim() !== '')
      .map((block) => ({
        id: /^id:\s*(.+)$/m.exec(block)?.[1]?.trim(),
        event: /^event:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? 'message',
        data: JSON.parse(/^data:\s*([\s\S]+)$/m.exec(block)?.[1]?.trim() ?? '{}') as Record<
          string,
          unknown
        >,
      }))
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
    client = createTestClient(
      createApp({
        dbConfig: db.config,
        mailer,
        turn: createTurnRunner(db.config, {
          models,
          modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
          definition,
          tools: [
            {
              name: 'look_up',
              summarise: () => 'three files',
            },
          ],
        }),
      }),
      mailer,
    )
  })

  it('CHAT-2 AC1/AC2: a user sends a message and receives a streamed reply with inline tool-call events', async () => {
    // Given a session
    const { ada, workspaceId, sessionId } = await session()
    models.script({ chunks: ['The parser ', 'does three jobs, ', 'and they can be split.'] })

    // When a message is posted
    const response = await ada.post(`/workspaces/${workspaceId}/sessions/${sessionId}/messages`, {
      text: 'Where does the invoice parser do too much?',
    })

    // Then the response streams incrementally
    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const events = await readStream(response)
    const kinds = events.map((event) => event.event)

    // Incrementally: more than one token frame, or this is a form submission
    // wearing a stream's content type.
    expect(kinds.filter((kind) => kind === 'token').length).toBeGreaterThan(1)

    // and the tool call is visible as it happens, named, with its outcome, and
    // *before* the tokens that follow it — a tool notice that arrives after the
    // answer tells the reader nothing they could not already see.
    const toolIndex = kinds.indexOf('tool_call')
    expect(toolIndex, 'the turn called a tool and the reader must see it').toBeGreaterThanOrEqual(0)
    expect(toolIndex).toBeLessThan(kinds.lastIndexOf('token'))
    expect(events[toolIndex]!.data).toMatchObject({ tool: 'look_up', summary: 'three files' })

    expect(kinds.at(-1)).toBe('done')

    // and the completed message is persisted exactly once, whole
    const session1 = (await (
      await ada.get(`/workspaces/${workspaceId}/sessions/${sessionId}`)
    ).json()) as { messages: Array<{ role: string; content: { text?: string } }> }

    const assistant = session1.messages.filter((message) => message.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]!.content.text).toBe('The parser does three jobs, and they can be split.')
  })

  it('CHAT-2 AC3: a reader who hangs up mid-turn leaves a marked partial and no orphan run', async () => {
    // Given a turn mid-stream
    const { ada, workspaceId, sessionId } = await session()
    // The fake holds after the second chunk, so "mid-stream" is a place in the
    // script rather than a moment on the clock. A test that raced a timer here
    // would be the flake it was written to prevent.
    models.script({
      chunks: ['The parser ', 'does three jobs, ', 'and they can be split.'],
      holdAfterChunks: 2,
    })

    const aborter = new AbortController()
    const response = await ada.request(
      `/workspaces/${workspaceId}/sessions/${sessionId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Where does the invoice parser do too much?' }),
        signal: aborter.signal,
      },
    )
    // Deliberately not reading the body to assert on it: the stream is held
    // open on purpose, so draining it here would wait for the answer this test
    // exists to interrupt.
    expect(response.status).toBe(200)

    // Read far enough to be genuinely mid-answer, then hang up.
    await models.reachedHold()

    // When the user interrupts
    aborter.abort()
    models.release()

    // Then the turn stops and settles. Polled on the condition rather than
    // slept on: the abort unwinds through the executor asynchronously, and the
    // condition — the partial having been written — is the thing being waited
    // for, not an interval somebody guessed.
    const assistantMessages = async (): Promise<
      Array<{ role: string; runId?: string; interrupted?: boolean; content: { text?: string } }>
    > => {
      const body = (await (
        await ada.get(`/workspaces/${workspaceId}/sessions/${sessionId}`)
      ).json()) as {
        messages: Array<{
          role: string
          runId?: string
          interrupted?: boolean
          content: { text?: string }
        }>
      }
      return body.messages.filter((m) => m.role === 'assistant')
    }

    await expect
      .poll(async () => (await assistantMessages()).length, { timeout: 15_000 })
      .toBe(1)
    const settled = (await assistantMessages())[0]!

    // the partial message is persisted, and says it is partial
    expect(settled.content.text, 'what the reader saw must be what is kept').toBe(
      'The parser does three jobs, ',
    )
    expect(
      settled.interrupted,
      'an answer that stops halfway must not be indistinguishable from one that finished',
    ).toBe(true)

    // the run ends in a terminal state — no orphan left running forever
    const [run] = await db.admin.query<{ status: string }>(
      `SELECT status FROM runs WHERE id = $1`,
      [settled.runId],
    )
    expect(run!.status, 'a run nobody is waiting for must not stay `running`').toBe('stopped')

    // and the spend up to the interruption is recorded, because it was spent
    const [spend] = await db.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM spend_ledger WHERE run_id = $1`,
      [settled.runId],
    )
    expect(
      Number(spend!.n),
      'tokens generated before the hang-up cost money whether or not anyone read them',
    ).toBeGreaterThan(0)
  })

  it('CHAT-2 AC6: each message names its author, and an agent message names the run behind it', async () => {
    // Given a session with one turn in it
    const { ada, workspaceId, sessionId } = await session()
    models.script({ chunks: ['Yes.'] })
    // Drained, not merely requested: the turn runs as the body is read, which
    // is the same reason a client that hangs up mid-turn is a case worth
    // having (AC3, still to come).
    await readStream(
      await ada.post(`/workspaces/${workspaceId}/sessions/${sessionId}/messages`, {
        text: 'Is the parser doing too much?',
      }),
    )

    // When the session is read
    const read = (await (
      await ada.get(`/workspaces/${workspaceId}/sessions/${sessionId}`)
    ).json()) as {
      messages: Array<{ role: string; authorUserId: string | null; runId: string | null }>
    }

    // Then the human message names its author
    const user = read.messages.find((message) => message.role === 'user')
    expect(user!.authorUserId).toBe(ada.userId)

    // and the agent message names the run that produced it, so a reader of the
    // transcript can reach the trace that explains it. Without this the answer
    // to "why did it say that?" is a search rather than a link.
    const assistant = read.messages.find((message) => message.role === 'assistant')
    expect(assistant!.authorUserId).toBeNull()
    expect(assistant!.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)

    const trace = await ada.get(`/workspaces/${workspaceId}/runs/${assistant!.runId}`)
    expect(trace.status, 'the run a message names must be one you can open').toBe(200)
  })

  it('CHAT-2 AC1: the user message is recorded before the turn runs, so a failed turn is not lost', async () => {
    // Given a session and a model that will fail
    const { ada, workspaceId, sessionId } = await session()
    models.script({ failWith: 'provider exploded' })

    // When a message is posted and the turn fails
    const response = await ada.post(`/workspaces/${workspaceId}/sessions/${sessionId}/messages`, {
      text: 'What broke?',
    })
    const events = await readStream(response)

    // Then the stream says so rather than ending silently — a stream that stops
    // without saying why leaves a reader waiting forever
    expect(events.map((event) => event.event)).toContain('error')

    // and what the person typed is still there. Losing their words because our
    // model failed is the least forgivable outcome available here.
    const read = (await (
      await ada.get(`/workspaces/${workspaceId}/sessions/${sessionId}`)
    ).json()) as { messages: Array<{ role: string; content: { text?: string } }> }
    expect(read.messages.some((message) => message.content.text === 'What broke?')).toBe(true)
  })
})
