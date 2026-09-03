import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { z } from 'zod'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { WorkflowDefinitionSchema, type AnyTool } from '@chorus/core'
import { createExecutor, createToolRegistry, type Executor } from '@chorus/agent'
import { loadPromptDirectory } from '@chorus/llm'
import { join } from 'node:path'
import { createApp } from '../../src/app.js'
import {
  createFakeModelProvider,
  createRecordingMailer,
  createTestClient,
  type FakeModelProvider,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * AGENT-4 — the trace.
 *
 * > An agent you cannot inspect is an agent you cannot improve or defend.
 *
 * The trace is four things at once — the debugging tool, the audit record, the
 * cost breakdown and the substrate for evaluation — and each of those fails
 * differently when it is incomplete. So the tests here are about completeness
 * and about *reconciliation*: a displayed cost that does not equal the calls
 * behind it is a number nobody can defend when it is questioned.
 *
 * Deliberately not covered here, and tracked as the next slice: redaction at
 * write time (AC3) and OpenTelemetry export accepted by a real collector (AC5).
 */
describe('AGENT-4 run traces', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let executor: Executor
  let models: FakeModelProvider

  const prompts = loadPromptDirectory(
    join(import.meta.dirname, '..', '..', '..', '..', 'workflows', 'prompts'),
  )

  const tool = (name: string): AnyTool =>
    ({
      name,
      description: name,
      input: z.object({}).passthrough(),
      output: z.object({}).passthrough(),
      sideEffect: 'none',
      requiredRole: 'member',
      requiredScopes: [],
      execute: async () => ({ ran: name }),
    }) as unknown as AnyTool

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    models = createFakeModelProvider({
      chunks: ['a considered answer'],
      usage: { inputTokens: 120, outputTokens: 45 },
    })
    executor = createExecutor(db.config, {
      registry: createToolRegistry([tool('prepare'), tool('finish')]),
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      // The real prompt directory, so AC2's "names the exact prompt template
      // version and hash" is asserted against a template that actually ships.
      prompts,
      // A deliberately simple price, so the ledger has non-zero rows to
      // reconcile against. Real pricing is deployment configuration.
      priceFor: (_model, usage) => usage.inputTokens + usage.outputTokens * 3,
    })
    client = createTestClient(
      createApp({
        dbConfig: db.config,
        mailer,
        resumeRun: async (workspaceId, runId) => {
          await executor.run(workspaceId, runId)
        },
      }),
      mailer,
    )
  })

  /** A run through a tool, a model call and a gate, then approved to the end. */
  async function completedRun(): Promise<{
    ada: SignedInUser
    workspaceId: string
    runId: string
  }> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Traced')
    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>

    const run = await executor.start({
      workspaceId: workspace.id,
      teamId: teams[0]!.id,
      startedBy: ada.userId,
      definition: WorkflowDefinitionSchema.parse({
        name: 'traced-flow',
        version: 1,
        tools: ['prepare', 'finish'],
        steps: [
          { id: 'prepare', type: 'tool', tool: 'prepare' },
          { id: 'think', type: 'model', prompt: 'routing/classify' },
          { id: 'gate', type: 'checkpoint', kind: 'before_create_artefacts' },
          { id: 'finish', type: 'tool', tool: 'finish' },
        ],
      }),
      input: {},
    })
    await executor.run(workspace.id, run.id)

    const view = (await (await ada.get(`/workspaces/${workspace.id}/runs/${run.id}`)).json()) as {
      checkpoint: { id: string }
    }
    await ada.post(`/workspaces/${workspace.id}/checkpoints/${view.checkpoint.id}/decision`, {
      decision: 'approve',
    })

    return { ada, workspaceId: workspace.id, runId: run.id }
  }

  const trace = async (ada: SignedInUser, workspaceId: string, runId: string) => {
    const response = await ada.get(`/workspaces/${workspaceId}/runs/${runId}/trace`)
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json() as Promise<{
      run: {
        status: string
        workflow: string
        costCents: number
        tokensIn: number
        tokensOut: number
        startedAt: string
        finishedAt: string | null
      }
      events: Array<{ seq: number; kind: string; at: string; payload: Record<string, unknown> }>
      spend: Array<{ provider: string; model: string; costCents: number }>
    }>
  }

  it('AGENT-4 AC1: every step appears, in order, with what it did', async () => {
    const { ada, workspaceId, runId } = await completedRun()
    const { events } = await trace(ada, workspaceId, runId)

    const kinds = events.map((event) => event.kind)
    expect(kinds).toContain('tool_call')
    expect(kinds).toContain('model_call')
    expect(kinds).toContain('checkpoint')

    // Ordered, and strictly: two events sharing a sequence number cannot be put
    // in order later, and "what happened first" is most of what a trace is for.
    const sequences = events.map((event) => event.seq)
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences)
    expect(new Set(sequences).size).toBe(sequences.length)
  })

  it('AGENT-4 AC1: the trace accounts for the whole run, start to finish', async () => {
    const { ada, workspaceId, runId } = await completedRun()
    const { run, events } = await trace(ada, workspaceId, runId)

    expect(run.status).toBe('succeeded')
    expect(run.finishedAt).not.toBeNull()

    // No event outside the run's own window. One that is means either the clock
    // or the attribution is wrong, and both make the trace untrustworthy.
    const started = Date.parse(run.startedAt)
    const finished = Date.parse(run.finishedAt!)
    for (const event of events) {
      const at = Date.parse(event.at)
      expect(at).toBeGreaterThanOrEqual(started)
      expect(at).toBeLessThanOrEqual(finished + 1000)
    }
  })

  it('AGENT-4 AC2: a model call names the model, the provider and the prompt it used', async () => {
    const { ada, workspaceId, runId } = await completedRun()
    const { events } = await trace(ada, workspaceId, runId)

    const call = events.find((event) => event.kind === 'model_call')
    expect(call, 'the run made a model call and the trace must show it').toBeDefined()

    // Enough to reproduce the inputs: which model, from which provider, and the
    // exact template text — by hash, because the file will change and a result
    // has to be replayable against the version that produced it.
    expect(call!.payload).toMatchObject({ provider: 'fake', model: 'fake-1' })
    expect(call!.payload.promptId).toBe('routing/classify')
    expect(call!.payload.promptVersion).toBe(1)
    expect(String(call!.payload.promptHash)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('AGENT-4 AC4: the displayed cost equals the sum of the ledger rows exactly', async () => {
    const { ada, workspaceId, runId } = await completedRun()
    const { run, spend } = await trace(ada, workspaceId, runId)

    expect(spend.length, 'a run that called a model has ledger rows').toBeGreaterThan(0)
    const summed = spend.reduce((total, row) => total + row.costCents, 0)

    // Exactly, not approximately. `runs.cost_cents` is a cache of this sum, and
    // a cache that can disagree with its source is a number nobody can defend.
    expect(run.costCents).toBe(summed)
  })

  it('AGENT-4 AC4: token counts reconcile too, not only the money', async () => {
    const { ada, workspaceId, runId } = await completedRun()
    const { run } = await trace(ada, workspaceId, runId)

    // The fake reported 120 in and 45 out for its one call. Tokens are what
    // cost is derived from, so a token count that does not match makes the cost
    // unexplainable even when it happens to be right.
    expect(run.tokensIn).toBe(120)
    expect(run.tokensOut).toBe(45)
  })

  it('AGENT-4 AC1: a checkpoint and its human decision both appear', async () => {
    const { ada, workspaceId, runId } = await completedRun()
    const { events } = await trace(ada, workspaceId, runId)

    const checkpoints = events.filter((event) => event.kind === 'checkpoint')
    expect(checkpoints.length).toBeGreaterThan(0)
    expect(checkpoints[0]!.payload).toMatchObject({ step: 'gate', mode: 'ask' })
  })

  it('AGENT-4 AC6: a run in another workspace is not readable', async () => {
    const { workspaceId, runId } = await completedRun()
    const bob = await client.signedInUser()

    // Not-found rather than forbidden: confirming the run exists would be
    // information in itself (WS-2 AC4).
    expect((await bob.get(`/workspaces/${workspaceId}/runs/${runId}/trace`)).status).toBe(404)
  })

  it('AGENT-4: a failed run still has a trace, which is the one that matters most', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Broken')
    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>

    const run = await executor.start({
      workspaceId: workspace.id,
      teamId: teams[0]!.id,
      startedBy: ada.userId,
      definition: WorkflowDefinitionSchema.parse({
        name: 'doomed-flow',
        version: 1,
        tools: ['prepare'],
        steps: [
          { id: 'prepare', type: 'tool', tool: 'prepare' },
          // Not in the allow-list, so the run fails at the second step.
          { id: 'sneak', type: 'tool', tool: 'finish' },
        ],
      }),
      input: {},
    })
    await executor.run(workspace.id, run.id)

    const { run: view, events } = await trace(ada, workspace.id, run.id)
    expect(view.status).toBe('failed')
    // "Write events as they happen, not at run completion." A buffered trace
    // would lose precisely the run somebody needs to read.
    expect(events.some((event) => event.kind === 'tool_call')).toBe(true)
    expect(events.some((event) => event.kind === 'error')).toBe(true)
  })
})
