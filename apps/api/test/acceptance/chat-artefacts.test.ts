import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { join } from 'node:path'
import { ulid, WorkflowDefinitionSchema, type WorkflowDefinition } from '@chorus/core'
import { WORKFLOW_ROOT } from '@chorus/agent'
import { loadPromptDirectory } from '@chorus/llm'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createRetriever } from '@chorus/brain'
import { createApp } from '../../src/app.js'
import { createTurnRunner } from '../../src/chat-turn.js'
import { chatArtefactTools } from '../../src/chat-tools.js'
import { createDocumentService } from '../../src/documents.js'
import { createTaskService } from '../../src/tasks.js'
import { createSessionService } from '../../src/sessions.js'
import { createWorkspaceService } from '../../src/workspaces.js'
import { createTeamService } from '../../src/teams.js'
import {
  createFakeModelProvider,
  createRecordingMailer,
  createTestClient,
  type FakeModelProvider,
  type TestClient,
} from '@chorus/testing'

/**
 * CHAT-6 — creating and refining artefacts from chat.
 *
 * The model proposes a ChatAction; `apply_chat_action` carries it out as the
 * person. A PRD asked for in chat is created and linked to the session (AC1);
 * a task named by key gets the criteria, attributed to the person (AC2); an
 * ambiguous reference is asked about rather than guessed (AC4); and the tool
 * cannot reach a task outside the session's team (AC5).
 */

const DEFINITION: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  name: 'shape-act-test',
  version: 1,
  model: 'balanced',
  inputs: { text: 'the instruction', session_id: 'the session' },
  tools: ['apply_chat_action'],
  steps: [
    { id: 'gather', type: 'retrieve', query: '{{input.text}}', limit: 5 },
    { id: 'plan', type: 'model', prompt: 'shape/plan-action' },
    {
      id: 'apply',
      type: 'tool',
      tool: 'apply_chat_action',
      input: { action: '{{plan.output}}', sessionId: '{{input.session_id}}' },
    },
    { id: 'reply', type: 'model', prompt: 'reply' },
  ],
})

const REGISTRY = loadPromptDirectory(join(WORKFLOW_ROOT, '..', 'prompts'))
const PROMPTS = {
  get(id: string) {
    if (id === 'reply') return { body: 'Here you go: {{text}}', version: 1, hash: 'reply' }
    return REGISTRY.get(id)
  },
}

interface Frame {
  event: string
  data: Record<string, unknown>
}

describe('CHAT-6 chat artefact edits', () => {
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
      tools: chatArtefactTools({
        documents: createDocumentService(db.config),
        tasks: createTaskService(db.config),
        sessions: createSessionService(db.config),
        workspaces: createWorkspaceService(db.config),
        teams: createTeamService(db.config),
      }),
    })
    app = createApp({ dbConfig: db.config, mailer, retriever, turn })
    client = createTestClient(app, mailer)
  })

  async function world() {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Shaping edits')
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

  it('CHAT-6: asking for a PRD in chat creates a linked draft document', async () => {
    const w = await world()
    models.script({
      structured: { action: 'create_document', documentType: 'prd', title: 'Billing PRD' },
      chunks: ['Created it.'],
    })

    const events = await turn(w, 'write a PRD for billing')

    // The tool reports the document it made.
    const toolCall = events.find((frame) => frame.event === 'tool_call')
    expect(toolCall?.data.summary).toContain('Billing PRD')

    // It exists, as a draft of the right type.
    const docs = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/teams/${w.teamId}/documents`)
    ).json()) as Array<{ id: string; type: string; status: string; title: string }>
    expect(docs).toEqual([expect.objectContaining({ type: 'prd', status: 'draft', title: 'Billing PRD' })])

    // And it is linked to the session (AC1).
    const sources = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/sessions/${w.sessionId}/sources`)
    ).json()) as Array<{ toType: string; toId: string }>
    expect(sources).toContainEqual(expect.objectContaining({ toType: 'document', toId: docs[0]!.id }))
  })

  it('CHAT-6: an artefact reference by key resolves to the right task and is attributed to the run', async () => {
    const w = await world()
    const task = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, {
        title: 'Split the invoice parser',
      })
    ).json()) as { id: string; key: string }
    models.script({
      structured: {
        action: 'refine_task',
        reference: task.key,
        acceptanceCriteria: ['Parsing is separated from validation'],
      },
      chunks: ['Added.'],
    })

    await turn(w, `add acceptance criteria to ${task.key}`)

    // The right task got the criterion.
    const read = (await (await w.ada.get(`/workspaces/${w.workspaceId}/tasks/${task.id}`)).json()) as {
      acceptanceCriteria: Array<{ text: string }>
    }
    expect(read.acceptanceCriteria.map((c) => c.text)).toEqual(['Parsing is separated from validation'])

    // Attributed to Ada, as the person the run acts for.
    const audit = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/audit?targetId=${task.id}`)
    ).json()) as { entries: Array<{ action: string; actorId: string }> }
    expect(audit.entries).toContainEqual(
      expect.objectContaining({ action: 'task.update', actorId: w.ada.userId }),
    )
  })

  it('CHAT-6: an ambiguous reference is asked about, not guessed (AC4)', async () => {
    const w = await world()
    for (const title of ['Billing spec task', 'Onboarding spec task']) {
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, { title })
    }
    models.script({
      structured: { action: 'refine_task', reference: 'the spec task', acceptanceCriteria: ['x'] },
      chunks: ['...'],
    })

    const events = await turn(w, 'add a criterion to the spec task')

    const clarification = events.find((frame) => frame.event === 'clarification')
    expect(clarification, 'two tasks match, so it must ask').toBeDefined()
    expect((clarification!.data.questions as Array<{ choices: unknown[] }>)[0]!.choices).toHaveLength(2)
    // Nothing was changed.
    const tasks = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`)
    ).json()) as Array<{ acceptanceCriteria: unknown[] }>
    expect(tasks.every((task) => task.acceptanceCriteria.length === 0)).toBe(true)
  })

  it('CHAT-6: the agent cannot change a task outside the session’s team (AC5)', async () => {
    const w = await world()
    // A task in another team the session does not work in.
    const otherTeamId = ulid()
    await db.admin.execute(
      `INSERT INTO teams (id, workspace_id, name, slug) VALUES ($1, $2, 'Platform', $3)`,
      [otherTeamId, w.workspaceId, `platform-${otherTeamId.slice(-6).toLowerCase()}`],
    )
    const foreign = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${otherTeamId}/tasks`, { title: 'Secret work' })
    ).json()) as { id: string; key: string }

    models.script({
      structured: { action: 'refine_task', reference: foreign.key, acceptanceCriteria: ['sneak'] },
      chunks: ['...'],
    })
    const events = await turn(w, `add a criterion to ${foreign.key}`)

    // It is out of reach: the tool declines, and the task is untouched.
    const toolCall = events.find((frame) => frame.event === 'tool_call')
    expect(toolCall?.data.summary).toMatch(/declined|no task/i)
    const read = (await (await w.ada.get(`/workspaces/${w.workspaceId}/tasks/${foreign.id}`)).json()) as {
      acceptanceCriteria: unknown[]
    }
    expect(read.acceptanceCriteria).toEqual([])
  })
})
