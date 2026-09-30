import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ulid, WorkflowDefinitionSchema, type AnyTool } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createExecutor, createToolRegistry, type Executor } from '@chorus/agent'
import { z } from 'zod'
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
 * NFR-8 — the spend guard (#168, architecture.md §9.3).
 *
 * A checkpoint raised after an expensive call is a notification: the money is
 * spent, and whoever approves it is approving something that already happened.
 * So every assertion that matters here is made **at the fake provider**: a
 * guard that fired is one where the provider recorded no request, and "the run
 * says it paused" is not evidence of that on its own.
 *
 * Limits are arranged as rows, because the screen for setting them is WS-7
 * (#22). This reads limits; it does not add a way to write them.
 */
describe('NFR-8 spend guard', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let models: FakeModelProvider
  let executor: Executor
  let toolCalls: string[]

  /** The middle of a month, so "this period" is unambiguous. */
  const NOW = new Date('2026-09-15T12:00:00Z')

  /** One cent per input token: any real prompt costs something to send. */
  const priceFor = (_model: unknown, usage: { inputTokens: number }) => usage.inputTokens

  const prepare: AnyTool = {
    name: 'prepare',
    description: 'prepare',
    input: z.object({}).passthrough(),
    output: z.object({ ran: z.literal(true) }),
    sideEffect: 'none',
    requiredRole: 'member',
    requiredScopes: [],
    execute: async () => {
      toolCalls.push('prepare')
      return { ran: true }
    },
  } as unknown as AnyTool

  /**
   * AC3's subject: a workflow whose author declared no `before_spend_over`
   * step. Every test uses it, because the guard is meant to be a property of
   * the platform rather than of a definition that remembered.
   */
  const definition = WorkflowDefinitionSchema.parse({
    name: 'unguarded-flow',
    version: 1,
    tools: ['prepare'],
    steps: [
      { id: 'prepare', type: 'tool', tool: 'prepare' },
      { id: 'answer', type: 'model', prompt: 'reply.md' },
    ],
  })

  interface World {
    ada: SignedInUser
    workspaceId: string
    teamId: string
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    toolCalls = []
    models = createFakeModelProvider()
    const mailer = createRecordingMailer()
    executor = createExecutor(db.config, {
      registry: createToolRegistry([prepare]),
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      priceFor,
      now: () => NOW,
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

  async function world(): Promise<World> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Budgeted')
    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    return { ada, workspaceId: workspace.id, teamId: teams[0]!.id }
  }

  /** A limit for the workspace, or for one team inside it. */
  async function limit(
    w: World,
    input: { teamId?: string; softCents?: number; hardCents?: number },
  ): Promise<void> {
    await db.admin.execute(
      `INSERT INTO spend_limits
         (id, workspace_id, team_id, period, soft_limit_cents, hard_limit_cents)
       VALUES ($1, $2, $3, 'month', $4, $5)`,
      [ulid(), w.workspaceId, input.teamId ?? null, input.softCents ?? null, input.hardCents ?? null],
    )
  }

  /** Spend already on the ledger, as earlier calls would have left it. */
  async function spent(
    w: World,
    input: { cents: number; teamId?: string | null; at?: string },
  ): Promise<void> {
    await db.admin.execute(
      `INSERT INTO spend_ledger
         (id, workspace_id, team_id, provider, model, purpose, cost_cents, at)
       VALUES ($1, $2, $3, 'fake', 'fake-1', 'chat', $4, $5)`,
      [
        ulid(),
        w.workspaceId,
        input.teamId === undefined ? w.teamId : input.teamId,
        input.cents,
        input.at ?? '2026-09-10T09:00:00Z',
      ],
    )
  }

  async function runIt(w: World, teamId = w.teamId) {
    const record = await executor.start({
      workspaceId: w.workspaceId,
      teamId,
      startedBy: w.ada.userId,
      definition,
      input: {},
    })
    const outcome = await executor.run(w.workspaceId, record.id)
    return { runId: record.id, outcome }
  }

  it('NFR-8: with no limits configured, nothing is gated', async () => {
    const w = await world()
    await spent(w, { cents: 1_000_000 })

    const { outcome } = await runIt(w)

    expect(outcome.status, outcome.error).toBe('succeeded')
    expect(models.requests()).toHaveLength(1)
  })

  it('NFR-8 AC1: a job that would cross the soft limit raises before_spend_over before any provider call', async () => {
    // Given a workspace close to its soft limit
    const w = await world()
    await limit(w, { softCents: 100 })
    await spent(w, { cents: 99 })

    // When the job that would cross it is considered
    const { runId, outcome } = await runIt(w)

    // Then the run waits, and the provider was never asked
    expect(outcome.status, outcome.error).toBe('waiting_human')
    expect(models.requests(), 'a guard that fires after the call is a notification').toHaveLength(0)

    const view = (await (await w.ada.get(`/workspaces/${w.workspaceId}/runs/${runId}`)).json()) as {
      checkpoint?: { id: string }
    }
    expect(view.checkpoint).toBeDefined()

    const checkpoint = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/checkpoints/${view.checkpoint!.id}`)
    ).json()) as { kind: string; status: string; payload: Record<string, unknown> }

    expect(checkpoint.kind).toBe('before_spend_over')
    expect(checkpoint.status).toBe('pending')
    // The counted figure is what makes this a price rather than a guess.
    expect(checkpoint.payload.countedInputTokens).toEqual(expect.any(Number))
    expect(checkpoint.payload.countedInputTokens as number).toBeGreaterThan(0)
    expect(checkpoint.payload).toMatchObject({
      scope: 'workspace',
      period: 'month',
      periodSpendCents: 99,
      softLimitCents: 100,
    })
  })

  it('NFR-8 AC1: approving the soft-limit checkpoint makes the call exactly once', async () => {
    const w = await world()
    await limit(w, { softCents: 100 })
    await spent(w, { cents: 99 })
    const { runId } = await runIt(w)

    const view = (await (await w.ada.get(`/workspaces/${w.workspaceId}/runs/${runId}`)).json()) as {
      checkpoint: { id: string }
    }
    const decided = await w.ada.post(
      `/workspaces/${w.workspaceId}/checkpoints/${view.checkpoint.id}/decision`,
      { decision: 'approve' },
    )
    expect(decided.status, await decided.clone().text()).toBe(200)

    const after = (await (await w.ada.get(`/workspaces/${w.workspaceId}/runs/${runId}`)).json()) as {
      status: string
    }
    expect(after.status).toBe('succeeded')
    expect(models.requests()).toHaveLength(1)
    expect(toolCalls, 'the step before the guard is not repeated').toEqual(['prepare'])
  })

  it('NFR-8 AC2: over the hard limit the run fails naming the limit and the period, with no call made', async () => {
    // Given a workspace over its hard limit
    const w = await world()
    await limit(w, { hardCents: 100 })
    await spent(w, { cents: 150 })

    // When a model-calling job is considered
    const { outcome } = await runIt(w)

    // Then it fails, says why, and the provider saw nothing
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatch(/hard spend limit/i)
    expect(outcome.error).toContain('100')
    expect(outcome.error).toMatch(/month/i)
    expect(outcome.error).toContain('2026-09-01')
    expect(models.requests()).toHaveLength(0)
  })

  it('NFR-8 AC2: spend from an earlier period does not count against this one', async () => {
    const w = await world()
    await limit(w, { hardCents: 100 })
    await spent(w, { cents: 10_000, at: '2026-08-20T09:00:00Z' })

    const { outcome } = await runIt(w)

    expect(outcome.status, outcome.error).toBe('succeeded')
    expect(models.requests()).toHaveLength(1)
  })

  it('NFR-8 AC3: a workflow with no before_spend_over step is still guarded', async () => {
    const w = await world()
    await limit(w, { softCents: 100 })
    await spent(w, { cents: 99 })

    // The definition declares no checkpoint at all — asserted, not assumed.
    expect(definition.steps.some((step) => step.type === 'checkpoint')).toBe(false)

    const { outcome } = await runIt(w)

    expect(outcome.status).toBe('waiting_human')
    expect(toolCalls, 'the steps before the model call still ran').toEqual(['prepare'])
    expect(models.requests()).toHaveLength(0)
  })

  it('NFR-8 AC4: a team under its own limit is refused when its workspace is over', async () => {
    const w = await world()
    await limit(w, { teamId: w.teamId, hardCents: 1_000_000 })
    await limit(w, { hardCents: 100 })
    // Another team's spend: the workspace is over, this team barely started.
    await spent(w, { cents: 150, teamId: null })

    const { outcome } = await runIt(w)

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatch(/workspace hard spend limit/i)
    expect(models.requests()).toHaveLength(0)
  })

  it('NFR-8 AC4: a team over its own limit is refused inside a workspace that is not', async () => {
    const w = await world()
    await limit(w, { hardCents: 1_000_000 })
    await limit(w, { teamId: w.teamId, hardCents: 100 })
    await spent(w, { cents: 150 })

    const { outcome } = await runIt(w)

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatch(/team hard spend limit/i)
    expect(models.requests()).toHaveLength(0)
  })
})
