import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { z } from 'zod'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { WorkflowDefinitionSchema, type AnyTool, type WorkflowDefinition } from '@chorus/core'
import { createExecutor, createToolRegistry, type Executor } from '@chorus/agent'
import { createApp } from '../../src/app.js'
import {
  createFakeModelProvider,
  createRecordingMailer,
  createTestClient,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * AGENT-3 — checkpoints, from the outside.
 *
 * The requirement's own words: *humans hold the gates*. So the thing under test
 * is not "a row was written" but the sequence a person actually experiences —
 * the run stops, they are shown the exact action proposed, and nothing happens
 * until they say so. Each test below asserts the gated side effect by counting
 * executions **at the tool**, because a run that reports itself as paused while
 * having already posted the message is the failure this exists to prevent.
 *
 * What is deliberately not asserted here: the notification transports. The
 * issue puts them out of scope (SLACK-2, SLACK-6, TEAMS-2) and WP-1.2 delivers
 * them. What *is* asserted is the property those transports depend on — one
 * checkpoint, settled once — which is what makes AC4 structural rather than a
 * race between surfaces.
 */
describe('AGENT-3 checkpoints', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let executor: Executor
  let gatedCalls: string[]

  /** A tool that records every execution, so a premature one is visible. */
  const counting = (name: string): AnyTool =>
    ({
      name,
      description: name,
      input: z.object({}).passthrough(),
      output: z.object({ ran: z.string() }),
      sideEffect: 'none',
      requiredRole: 'member',
      requiredScopes: [],
      execute: async () => {
        gatedCalls.push(name)
        return { ran: name }
      },
    }) as unknown as AnyTool

  /** Prepare, gate, act — the shape every gated workflow has. */
  const definition = (overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition =>
    WorkflowDefinitionSchema.parse({
      name: 'gated-flow',
      version: 1,
      tools: ['prepare', 'act'],
      steps: [
        { id: 'prepare', type: 'tool', tool: 'prepare' },
        { id: 'gate', type: 'checkpoint', kind: 'before_create_artefacts' },
        { id: 'act', type: 'tool', tool: 'act' },
      ],
      ...overrides,
    })

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    gatedCalls = []
    const mailer = createRecordingMailer()
    const models = createFakeModelProvider()
    executor = createExecutor(db.config, {
      registry: createToolRegistry([counting('prepare'), counting('act')]),
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
    })
    client = createTestClient(
      createApp({
        dbConfig: db.config,
        mailer,
        // The API settles a decision; it does not execute runs. Resumption is a
        // queued job in a deployment, so the seam is injected rather than the
        // route calling the engine inline.
        resumeRun: async (workspaceId, runId) => {
          await executor.run(workspaceId, runId)
        },
      }),
      mailer,
    )
  })

  /** A run stopped at its `ask` gate, which is the arrangement every test needs. */
  async function pausedRun(): Promise<{
    ada: SignedInUser
    workspaceId: string
    runId: string
    checkpointId: string
  }> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Gated')
    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>

    const run = await executor.start({
      workspaceId: workspace.id,
      teamId: teams[0]!.id,
      startedBy: ada.userId,
      definition: definition(),
      input: {},
    })
    await executor.run(workspace.id, run.id)

    const view = await ada.get(`/workspaces/${workspace.id}/runs/${run.id}`)
    expect(view.status, await view.clone().text()).toBe(200)
    const body = (await view.json()) as { status: string; checkpoint?: { id: string } }
    expect(body.status, 'the default policy is ask, so the run must be waiting').toBe(
      'waiting_human',
    )
    expect(body.checkpoint, 'a waiting run must expose the checkpoint it waits on').toBeDefined()

    return { ada, workspaceId: workspace.id, runId: run.id, checkpointId: body.checkpoint!.id }
  }

  it('AGENT-3 AC1: with no configured policy the run pauses and asks, having done nothing gated', async () => {
    const { ada, workspaceId, checkpointId } = await pausedRun()

    // The step before the gate ran; the step after it did not. Counted at the
    // tool, because the run's own account of itself is what is in question.
    expect(gatedCalls).toEqual(['prepare'])

    const checkpoint = (await (
      await ada.get(`/workspaces/${workspaceId}/checkpoints/${checkpointId}`)
    ).json()) as { kind: string; status: string; mode: string; source: string }

    expect(checkpoint).toMatchObject({
      kind: 'before_create_artefacts',
      status: 'pending',
      mode: 'ask',
      // Which tier decided, so a surprising gate is diagnosable.
      source: 'platform',
    })
  })

  it('AGENT-3 AC3: approving resumes the run and performs the gated action exactly once', async () => {
    const { ada, workspaceId, runId, checkpointId } = await pausedRun()

    const decided = await ada.post(
      `/workspaces/${workspaceId}/checkpoints/${checkpointId}/decision`,
      { decision: 'approve' },
    )
    expect(decided.status, await decided.clone().text()).toBe(200)

    const run = (await (await ada.get(`/workspaces/${workspaceId}/runs/${runId}`)).json()) as {
      status: string
    }
    expect(run.status).toBe('succeeded')
    expect(gatedCalls, 'the gated step runs once, and only after approval').toEqual([
      'prepare',
      'act',
    ])
  })

  it('AGENT-3 AC3: the decision, the decider and the time are recorded', async () => {
    const { ada, workspaceId, checkpointId } = await pausedRun()

    await ada.post(`/workspaces/${workspaceId}/checkpoints/${checkpointId}/decision`, {
      decision: 'approve',
    })

    const settled = (await (
      await ada.get(`/workspaces/${workspaceId}/checkpoints/${checkpointId}`)
    ).json()) as { status: string; decidedBy: string; decidedAt: string }

    expect(settled.status).toBe('approved')
    expect(settled.decidedBy, 'a gate with no named decider is not accountable').toBe(ada.userId)
    expect(Date.parse(settled.decidedAt)).not.toBeNaN()
  })

  it('AGENT-3 AC3: rejecting terminates the run cleanly without performing the action', async () => {
    const { ada, workspaceId, runId, checkpointId } = await pausedRun()

    const decided = await ada.post(
      `/workspaces/${workspaceId}/checkpoints/${checkpointId}/decision`,
      { decision: 'reject', note: 'wrong repository' },
    )
    expect(decided.status, await decided.clone().text()).toBe(200)

    const run = (await (await ada.get(`/workspaces/${workspaceId}/runs/${runId}`)).json()) as {
      status: string
      error: string | null
    }
    // Stopped, not failed: a person decided this, and calling it a failure
    // would put a working system in an error dashboard.
    expect(run.status).toBe('stopped')
    expect(run.error).toContain('wrong repository')
    expect(gatedCalls).toEqual(['prepare'])
  })

  it('AGENT-3 AC4: the first decision wins, and a second is refused rather than applied', async () => {
    const { ada, workspaceId, runId, checkpointId } = await pausedRun()

    const first = await ada.post(
      `/workspaces/${workspaceId}/checkpoints/${checkpointId}/decision`,
      { decision: 'approve' },
    )
    expect(first.status).toBe(200)

    // The stale button on the other surface. It must not re-decide, and it must
    // not silently succeed either — the person pressing it needs to see what
    // actually happened.
    const second = await ada.post(
      `/workspaces/${workspaceId}/checkpoints/${checkpointId}/decision`,
      { decision: 'reject' },
    )
    expect(second.status).toBe(409)
    expect((await second.json()) as { settled?: unknown }).toMatchObject({
      settled: { status: 'approved', decidedBy: ada.userId },
    })

    const run = (await (await ada.get(`/workspaces/${workspaceId}/runs/${runId}`)).json()) as {
      status: string
    }
    expect(run.status, 'the rejection must not have reopened or stopped the run').toBe('succeeded')
    expect(gatedCalls).toEqual(['prepare', 'act'])
  })

  it('AGENT-3 AC4: every surface reads the same settled outcome', async () => {
    const { ada, workspaceId, checkpointId } = await pausedRun()
    await ada.post(`/workspaces/${workspaceId}/checkpoints/${checkpointId}/decision`, {
      decision: 'approve',
    })

    // Standing in for "the web UI, email and a chat surface": two independent
    // reads of the same checkpoint, after the fact, must agree.
    const [one, two] = await Promise.all([
      ada.get(`/workspaces/${workspaceId}/checkpoints/${checkpointId}`).then((r) => r.json()),
      ada.get(`/workspaces/${workspaceId}/checkpoints/${checkpointId}`).then((r) => r.json()),
    ])
    expect(one).toEqual(two)
    expect((one as { status: string }).status).toBe('approved')
  })

  it('AGENT-3: a checkpoint shows the action it is gating, not a summary of it', async () => {
    const { ada, workspaceId, checkpointId } = await pausedRun()

    const checkpoint = (await (
      await ada.get(`/workspaces/${workspaceId}/checkpoints/${checkpointId}`)
    ).json()) as { payload: { step: string; workflow: string; proposed: unknown } }

    // "A gate you cannot see through is not a gate." The payload names the step
    // about to run and the work it will act on.
    expect(checkpoint.payload).toMatchObject({ step: 'gate', workflow: 'gated-flow@1' })
    expect(checkpoint.payload.proposed).toBeDefined()
  })

  it('AGENT-3: a checkpoint in another workspace is not visible or decidable', async () => {
    const { workspaceId, checkpointId } = await pausedRun()

    const bob = await client.signedInUser()
    const elsewhere = await bob.createWorkspace('Somewhere Else')

    // 404 rather than 403, in both directions. Answering "forbidden" for a
    // workspace Bob is not in would confirm that it exists, and existence is
    // information (WS-2 AC4).
    expect((await bob.get(`/workspaces/${workspaceId}/checkpoints/${checkpointId}`)).status).toBe(
      404,
    )
    expect((await bob.get(`/workspaces/${elsewhere.id}/checkpoints/${checkpointId}`)).status).toBe(
      404,
    )
    expect(
      (
        await bob.post(`/workspaces/${elsewhere.id}/checkpoints/${checkpointId}/decision`, {
          decision: 'approve',
        })
      ).status,
    ).toBe(404)
  })
})
