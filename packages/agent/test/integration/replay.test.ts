import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { join } from 'node:path'
import { z } from 'zod'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid, WorkflowDefinitionSchema, type AnyTool } from '@chorus/core'
import { createFakeModelProvider, type FakeModelProvider } from '@chorus/testing'
import { loadPromptDirectory } from '@chorus/llm'
import { createExecutor, type Executor } from '../../src/executor.js'
import { replayRun } from '../../src/replay.js'
import { createToolRegistry } from '../../src/registry.js'

/**
 * NFR-11 AC3 and AC4 — replayable inputs, and hooks nobody opts into.
 *
 * AC4's wording is the load-bearing part: *without the workflow needing to opt
 * in*. A hook a workflow has to declare is one the fourth workflow forgets, and
 * the evaluation harness then reports on three of them and looks healthy. So
 * the test is an enumeration: every step a run executed must have left a record,
 * and it must be true of a workflow whose definition says nothing about traces.
 *
 * AC3 is bounded by what the run kept. A workspace at `structural` has no
 * bodies to replay, and the honest answer there is to say so rather than to
 * hand back a reconstruction that quietly differs from what was actually sent.
 */
describe('NFR-11 replay and hooks', () => {
  let db: IsolatedDatabase
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
      execute: async () => ({ items: ['one', 'two'] }),
    }) as unknown as AnyTool

  async function workspace(level?: string): Promise<{
    workspaceId: string
    userId: string
    teamId: string
  }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    if (level) {
      await db.admin.execute(`UPDATE workspaces SET redaction_level = $2 WHERE id = $1`, [
        workspaceId,
        level,
      ])
    }
    const [member] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1`,
      [workspaceId],
    )
    const [team] = await db.admin.query<{ id: string }>(
      `SELECT id FROM teams WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    await db.admin.execute(`DELETE FROM run_events WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM run_steps WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM runs WHERE workspace_id = $1`, [workspaceId])
    return { workspaceId, userId: member!.user_id, teamId: team!.id }
  }

  /**
   * A workflow using every step type the executor implements, and declaring
   * nothing at all about tracing or evaluation.
   */
  const everyStepType = WorkflowDefinitionSchema.parse({
    name: 'busy-flow',
    version: 1,
    // The model step uses a real shipped prompt, so the run has to be able to
    // fill its placeholders. A prompt sent with one unfilled is a step failure
    // now, which is why they are declared here rather than left to chance.
    inputs: { workflows: 'the list offered to the classifier', trigger: 'what arrived' },
    tools: ['collect', 'body', 'after'],
    steps: [
      { id: 'collect', type: 'tool', tool: 'collect' },
      { id: 'think', type: 'model', prompt: 'routing/classify' },
      { id: 'pick', type: 'branch', when: '{{collect.output}}', then: ['after'], otherwise: [] },
      { id: 'each', type: 'loop', over: '{{collect.output}}', body: ['body'], maxIterations: 5 },
      { id: 'body', type: 'tool', tool: 'body' },
      { id: 'after', type: 'tool', tool: 'after' },
    ],
  })

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    models = createFakeModelProvider({
      chunks: ['a considered answer'],
      usage: { inputTokens: 30, outputTokens: 12 },
    })
    executor = createExecutor(db.config, {
      registry: createToolRegistry([tool('collect'), tool('body'), tool('after')]),
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      prompts,
    })
  })

  async function run(level?: string) {
    const world = await workspace(level)
    const record = await executor.start({
      workspaceId: world.workspaceId,
      teamId: world.teamId,
      startedBy: world.userId,
      definition: everyStepType,
      input: { workflows: '- shape-idea', trigger: '{"kind":"chat"}' },
    })
    const outcome = await executor.run(world.workspaceId, record.id)
    return { ...world, runId: record.id, outcome }
  }

  it('NFR-11 AC4: every step a run executed left a record, with nothing opted into', async () => {
    const { runId, outcome } = await run()
    expect(outcome.status).toBe('succeeded')

    const events = await db.admin.query<{ kind: string; payload: { step?: string } }>(
      `SELECT kind, payload FROM run_events WHERE run_id = $1 ORDER BY seq`,
      [runId],
    )
    const steps = await db.admin.query<{ step_id: string; status: string; step_type: string }>(
      `SELECT step_id, status, step_type FROM run_steps WHERE run_id = $1`,
      [runId],
    )

    // Every step that actually ran. A skipped branch arm did no work and has
    // nothing to report; anything that executed must be accounted for, or the
    // evaluation harness reports on a subset and looks healthy.
    const executed = steps.filter((step) => step.status === 'succeeded')
    expect(executed.length).toBeGreaterThan(3)

    const recorded = new Set(events.map((event) => event.payload.step).filter(Boolean))
    for (const step of executed) {
      // Loop iterations are recorded under `body#0`; the record is against the
      // step they came from.
      const id = step.step_id.split('#')[0]!
      expect(recorded, `step "${step.step_id}" executed but emitted no event`).toContain(id)
    }
  })

  it('NFR-11 AC4: the definition says nothing about tracing, and never has to', async () => {
    // The property in one assertion: this workflow declares steps and tools and
    // nothing else, and it is fully traced regardless.
    expect(JSON.stringify(everyStepType)).not.toMatch(/trace|eval|hook|record/i)

    const { runId } = await run()
    const [count] = await db.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM run_events WHERE run_id = $1`,
      [runId],
    )
    expect(Number(count!.n)).toBeGreaterThan(3)
  })

  it('NFR-11 AC3: at `none` a model call replays exactly what was sent', async () => {
    const { workspaceId, runId } = await run('none')

    const replay = await replayRun(db.config, workspaceId, runId)
    expect(replay.calls).toHaveLength(1)

    const call = replay.calls[0]!
    expect(call.replayable).toBe(true)
    // The exact text, not a reconstruction. A prompt rebuilt from a template
    // and today's inputs is a different prompt from the one that ran.
    expect(call.prompt).toContain('Choose which workflow')
    expect(call.model).toMatchObject({ provider: 'fake', model: 'fake-1' })
  })

  it('NFR-11 AC3: the template is named even when the body is not kept', async () => {
    const { workspaceId, runId } = await run('structural')

    const call = (await replayRun(db.config, workspaceId, runId)).calls[0]!

    // Not replayable, and it says so rather than handing back something that
    // looks like the original and is not.
    expect(call.replayable).toBe(false)
    expect(call.prompt).toBeUndefined()
    expect(call.reason).toMatch(/redact/i)

    // But the provenance survives, which is what AC2 pins: the template can be
    // fetched at that version and compared against the hash.
    expect(call.template).toMatchObject({ id: 'routing/classify', version: 1 })
    expect(String(call.template?.hash)).toMatch(/^[0-9a-f]{64}$/)
    // And the hash of what was sent, so a reconstruction can be *verified*
    // against it even though the text itself is gone.
    expect(String(call.promptHash)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('NFR-11 AC3: at `full` there is nothing to verify against, and that is stated', async () => {
    const { workspaceId, runId } = await run('full')

    const call = (await replayRun(db.config, workspaceId, runId)).calls[0]!
    expect(call.replayable).toBe(false)
    expect(call.promptHash).toBeUndefined()
    // The template reference is all that remains, and it is still worth having.
    expect(call.template?.id).toBe('routing/classify')
  })

  it('NFR-11 AC3: replaying a run in another workspace finds nothing', async () => {
    const { runId } = await run()
    const other = await workspace()

    await expect(replayRun(db.config, other.workspaceId, runId)).rejects.toThrow(/no such run/i)
  })
})
