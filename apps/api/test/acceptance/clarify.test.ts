import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { join } from 'node:path'
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '@chorus/core'
import { WORKFLOW_ROOT } from '@chorus/agent'
import { loadPromptDirectory } from '@chorus/llm'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createRetriever } from '@chorus/brain'
import { createApp } from '../../src/app.js'
import { createTurnRunner } from '../../src/chat-turn.js'
import {
  createFakeModelProvider,
  createRecordingMailer,
  createTestClient,
  type FakeModelProvider,
  type TestClient,
} from '@chorus/testing'

/**
 * CHAT-4 — bounded clarifying questions, as a person meets them in a turn.
 *
 * A vague idea draws a few questions and no answer; a specific one draws none
 * and gets on with it. An answer, once given, settles its subject: the next
 * turn is not allowed to ask it again, whatever the model proposes. The budget
 * and the suppression are the turn's guarantees, held in code, so a model that
 * over-asks or re-asks is still kept to them.
 */

/** The shaping turn under test: retrieve, propose questions, bound them, then either ask or answer. */
const DEFINITION: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  name: 'shape-idea-test',
  version: 1,
  model: 'balanced',
  inputs: { text: 'the idea', answers: 'settled answers', known_subjects: 'subjects to skip' },
  tools: ['clarify'],
  steps: [
    { id: 'gather', type: 'retrieve', query: '{{input.text}}', limit: 5 },
    { id: 'ask', type: 'model', prompt: 'shape/clarify' },
    {
      id: 'decide',
      type: 'tool',
      tool: 'clarify',
      input: { clarification: '{{ask.output}}', known: '{{input.known_subjects}}', budget: 3 },
    },
    { id: 'gate', type: 'branch', when: '{{decide.output}}', then: ['answer'], otherwise: [] },
    { id: 'answer', type: 'model', prompt: 'reply' },
  ],
})

const CLARIFY_PROMPTS = loadPromptDirectory(join(WORKFLOW_ROOT, '..', 'prompts'))
/** The real clarify template, plus a trivial streaming answer prompt the test owns. */
const PROMPTS = {
  get(id: string) {
    if (id === 'reply') return { body: 'Here is a plan for: {{text}}', version: 1, hash: 'reply' }
    return CLARIFY_PROMPTS.get(id)
  },
}

interface Frame {
  event: string
  data: Record<string, unknown>
}

describe('CHAT-4 bounded clarifying questions', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let models: FakeModelProvider
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    models = createFakeModelProvider()
    const retriever = createRetriever(db.config, {
      models,
      embeddingModel: { provider: 'fake', model: 'fake-embed' },
    })
    const turn = createTurnRunner(db.config, {
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      definition: DEFINITION,
      retriever,
      prompts: PROMPTS,
    })
    app = createApp({ dbConfig: db.config, mailer, retriever, turn })
    client = createTestClient(app, mailer)
  })

  async function world() {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Shaping')
    const [team] = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{ id: string }>
    const started = (await (
      await ada.post(`/workspaces/${workspace.id}/teams/${team!.id}/sessions`, { entryPoint: 'idea' })
    ).json()) as { id: string }
    return { ada, workspaceId: workspace.id, teamId: team!.id, sessionId: started.id }
  }

  async function turn(w: Awaited<ReturnType<typeof world>>, text: string): Promise<Frame[]> {
    const response = await w.ada.post(`/workspaces/${w.workspaceId}/sessions/${w.sessionId}/messages`, { text })
    expect(response.status, await response.clone().text()).toBe(200)
    const body = await response.text()
    return body
      .split('\n\n')
      .filter((block) => block.trim() !== '')
      .map((block) => ({
        event: /^event:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? 'message',
        data: JSON.parse(/^data:\s*([\s\S]+)$/m.exec(block)?.[1]?.trim() ?? '{}') as Record<string, unknown>,
      }))
  }

  const q = (about: string, question: string, choices: Array<{ id: string; label: string }> = []) => ({
    id: about,
    about,
    question,
    choices,
  })

  it('CHAT-4: a vague idea produces at most N clarifying questions, then progress', async () => {
    // Given a model that, faced with a vague idea, proposes five questions
    const w = await world()
    models.script({
      structured: {
        questions: [
          q('repository', 'Which repository?'),
          q('scope', 'How broad is the change?'),
          q('deadline', 'By when?'),
          q('auth', 'Which auth model?'),
          q('storage', 'Which datastore?'),
        ],
      },
    })

    // When a vague idea is sent
    const asked = await turn(w, 'make it better')

    // Then the turn asks, bounded to three, and produces no answer
    const clarification = asked.find((frame) => frame.event === 'clarification')
    expect(clarification, 'a vague idea must draw clarifying questions').toBeDefined()
    const questions = clarification!.data.questions as Array<{ about: string }>
    expect(questions).toHaveLength(3)
    expect(asked.some((frame) => frame.event === 'token')).toBe(false)

    // and the transcript records the questions as the assistant's message
    const session = (await (await w.ada.get(`/workspaces/${w.workspaceId}/sessions/${w.sessionId}`)).json()) as {
      messages: Array<{ role: string; content: { questions?: unknown[]; text?: string } }>
    }
    const assistant = session.messages.find((message) => message.role === 'assistant')
    expect(assistant!.content.questions).toHaveLength(3)

    // Then the person answers, and the next turn makes progress
    await w.ada.post(`/workspaces/${w.workspaceId}/sessions/${w.sessionId}/answers`, {
      answers: questions.map((each) => ({ subject: each.about, answer: 'decided' })),
    })
    models.script({ structured: { questions: [] }, chunks: ['Here ', 'is ', 'the plan.'] })
    const progressed = await turn(w, 'go on')
    expect(progressed.some((frame) => frame.event === 'clarification')).toBe(false)
    expect(progressed.some((frame) => frame.event === 'token')).toBe(true)
  })

  it('CHAT-4: a specific request produces no clarifying questions', async () => {
    const w = await world()
    // The model judges the request clear and asks nothing; the turn answers.
    models.script({ structured: { questions: [] }, chunks: ['Done.'] })

    const events = await turn(w, 'Rename getUser to loadUser in src/users.ts and update its callers')

    expect(events.some((frame) => frame.event === 'clarification')).toBe(false)
    expect(events.some((frame) => frame.event === 'token')).toBe(true)
  })

  it('CHAT-4: multiple-choice options are carried to the person', async () => {
    const w = await world()
    models.script({
      structured: {
        questions: [
          q('repository', 'Which repository?', [
            { id: 'web', label: 'acme/web' },
            { id: 'api', label: 'acme/api' },
          ]),
        ],
      },
    })

    const events = await turn(w, 'add a settings page')

    const questions = events.find((frame) => frame.event === 'clarification')!.data.questions as Array<{
      choices: Array<{ id: string; label: string }>
    }>
    expect(questions[0]!.choices.map((choice) => choice.label)).toEqual(['acme/web', 'acme/api'])
  })

  it('CHAT-4: an answered subject is never asked again, whatever the model proposes', async () => {
    // Given a first turn that asked about the repository, answered by the person
    const w = await world()
    models.script({ structured: { questions: [q('repository', 'Which repository?')] } })
    await turn(w, 'add a page')
    await w.ada.post(`/workspaces/${w.workspaceId}/sessions/${w.sessionId}/answers`, {
      answers: [{ subject: 'repository', question: 'Which repository?', answer: 'acme/web' }],
    })

    // When the model, next turn, proposes the repository again alongside a new one
    models.script({
      structured: {
        questions: [q('repository', 'Which repository, again?'), q('deadline', 'By when?')],
      },
    })
    const events = await turn(w, 'carry on')

    // Then the settled subject is dropped in code, and only the genuinely new one is asked
    const questions = events.find((frame) => frame.event === 'clarification')!.data.questions as Array<{
      about: string
    }>
    expect(questions.map((each) => each.about)).toEqual(['deadline'])
  })

  it('CHAT-4: answers are recorded as structured session state, and read back', async () => {
    const w = await world()

    const recorded = await w.ada.post(`/workspaces/${w.workspaceId}/sessions/${w.sessionId}/answers`, {
      answers: [{ subject: 'Target Framework', question: 'Which framework?', answer: 'Next.js' }],
    })
    expect(recorded.status, await recorded.clone().text()).toBe(200)

    const stored = (await recorded.json()) as Array<{ subject: string; answer: string }>
    expect(stored).toEqual([{ subject: 'target framework', question: 'Which framework?', answer: 'Next.js' }])
  })
})
