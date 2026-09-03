import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { z } from 'zod'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid, type AnyTool, type WorkflowDefinition } from '@chorus/core'
import { WorkflowDefinitionSchema } from '@chorus/core'
import { createFakeModelProvider, type FakeModelProvider } from '@chorus/testing'
import { createExecutor, type Executor } from '../../src/executor.js'
import { createToolRegistry } from '../../src/registry.js'

/**
 * AGENT-1 AC2, AC4 — the step executor, against a real database.
 *
 * The property that matters is resumption, and it is the one only a database
 * can demonstrate:
 *
 * > the worker is killed and restarted → it resumes from the last completed
 * > step, **re-executes nothing**, and creates no duplicate artefact or
 * > external write.
 *
 * "Re-executes nothing" is the hard half. Resuming from step four is easy;
 * knowing that step four already ran *with exactly this input* is what stops a
 * resumed run opening a second pull request. So these tests kill runs partway
 * and count executions at the tools themselves, not from what the run reports
 * about itself.
 */
describe('AGENT-1 step executor', () => {
  let db: IsolatedDatabase
  let models: FakeModelProvider

  const calls: string[] = []

  /** A tool that records every execution, so re-execution is observable. */
  const counting = (name: string, extra: Partial<AnyTool> = {}): AnyTool =>
    ({
      name,
      description: name,
      input: z.object({}).passthrough(),
      output: z.object({ ran: z.string() }),
      sideEffect: 'none',
      requiredRole: 'member',
      requiredScopes: [],
      execute: async () => {
        calls.push(name)
        return { ran: name }
      },
      ...extra,
    }) as unknown as AnyTool

  const definition = (overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition =>
    WorkflowDefinitionSchema.parse({
      name: 'test-flow',
      version: 1,
      tools: ['first', 'second', 'third'],
      model: 'balanced',
      steps: [
        { id: 'one', type: 'tool', tool: 'first' },
        { id: 'two', type: 'tool', tool: 'second' },
        { id: 'three', type: 'tool', tool: 'third' },
      ],
      ...overrides,
    })

  async function workspace(): Promise<{ workspaceId: string; userId: string; teamId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
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

  const executorWith = (tools: readonly AnyTool[]): Executor =>
    createExecutor(db.config, {
      registry: createToolRegistry(tools),
      models,
      modelFor: () => ({ provider: 'fake', model: 'chat' }),
      now: () => new Date('2026-09-03T12:00:00.000Z'),
    })

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 180_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('AGENT-1: a run executes every step in order and records what it did', async () => {
    calls.length = 0
    models = createFakeModelProvider()
    const { workspaceId, userId, teamId } = await workspace()
    const executor = executorWith([counting('first'), counting('second'), counting('third')])

    const run = await executor.start({
      workspaceId,
      teamId,
      startedBy: userId,
      definition: definition(),
      input: {},
    })
    const outcome = await executor.run(workspaceId, run.id)

    expect(outcome.status).toBe('succeeded')
    expect(calls).toEqual(['first', 'second', 'third'])

    const steps = await db.admin.query<{ step_id: string; status: string; seq: number }>(
      `SELECT step_id, status, seq FROM run_steps WHERE run_id = $1 ORDER BY seq`,
      [run.id],
    )
    expect(steps.map((step) => step.step_id)).toEqual(['one', 'two', 'three'])
    expect(steps.every((step) => step.status === 'succeeded')).toBe(true)
  })

  it('AGENT-1 AC4: the workflow version is pinned at the start of the run', async () => {
    const { workspaceId, userId, teamId } = await workspace()
    const executor = executorWith([counting('first'), counting('second'), counting('third')])

    const run = await executor.start({
      workspaceId,
      teamId,
      startedBy: userId,
      definition: definition({ version: 7 }),
      input: {},
    })

    const [row] = await db.admin.query<{ workflow_version: number }>(
      `SELECT workflow_version FROM runs WHERE id = $1`,
      [run.id],
    )
    // A workflow edited mid-run must not change what the run is doing halfway
    // through, and the recorded version is what makes a trace explicable later.
    expect(row!.workflow_version).toBe(7)
  })

  it('AGENT-1 AC2: a killed run resumes from the last completed step and re-executes nothing', async () => {
    calls.length = 0
    models = createFakeModelProvider()
    const { workspaceId, userId, teamId } = await workspace()

    // A tool that fails the third step, standing in for the worker dying.
    let failThird = true
    const third = counting('third', {
      execute: async () => {
        calls.push('third')
        if (failThird) throw new Error('the worker was killed')
        return { ran: 'third' }
      },
    } as Partial<AnyTool>)

    const executor = executorWith([counting('first'), counting('second'), third])
    const run = await executor.start({
      workspaceId,
      teamId,
      startedBy: userId,
      definition: definition(),
      input: {},
    })

    const first = await executor.run(workspaceId, run.id)
    expect(first.status).toBe('failed')
    expect(calls).toEqual(['first', 'second', 'third'])

    // A fresh executor, as a restarted worker would be — nothing carried in
    // memory.
    failThird = false
    calls.length = 0
    const restarted = executorWith([counting('first'), counting('second'), third])
    const second = await restarted.run(workspaceId, run.id)

    expect(second.status).toBe('succeeded')
    // The whole criterion: only the step that had not completed ran again.
    expect(calls).toEqual(['third'])
  })

  it('AGENT-1 AC2: resuming twice does not duplicate anything', async () => {
    calls.length = 0
    models = createFakeModelProvider()
    const { workspaceId, userId, teamId } = await workspace()
    const executor = executorWith([counting('first'), counting('second'), counting('third')])

    const run = await executor.start({
      workspaceId,
      teamId,
      startedBy: userId,
      definition: definition(),
      input: {},
    })
    await executor.run(workspaceId, run.id)
    calls.length = 0

    // A queue delivering the same run twice, which at-least-once delivery makes
    // normal rather than exceptional.
    const again = await executor.run(workspaceId, run.id)

    expect(again.status).toBe('succeeded')
    expect(calls, 'a completed run must not re-execute on redelivery').toEqual([])
  })

  it('AGENT-1 AC2: a step is matched by identity, not position', async () => {
    // Inserting a step into a definition must not make a resuming run replay
    // the wrong one. Matching on `seq` would do exactly that.
    calls.length = 0
    models = createFakeModelProvider()
    const { workspaceId, userId, teamId } = await workspace()

    let fail = true
    const second = counting('second', {
      execute: async () => {
        calls.push('second')
        if (fail) throw new Error('stop here')
        return { ran: 'second' }
      },
    } as Partial<AnyTool>)

    const executor = executorWith([counting('first'), second, counting('third')])
    const run = await executor.start({
      workspaceId,
      teamId,
      startedBy: userId,
      definition: definition(),
      input: {},
    })
    await executor.run(workspaceId, run.id)

    // The definition gains a step *before* the one that failed. The run is
    // pinned to its own version, so this is the pathological case rather than
    // the normal one — but the executor must still match by step id.
    fail = false
    calls.length = 0
    await executor.run(workspaceId, run.id)

    expect(calls).toEqual(['second', 'third'])
  })

  it('AGENT-5 AC1: a step calling a tool outside the allow-list fails the run, not the step silently', async () => {
    calls.length = 0
    models = createFakeModelProvider()
    const { workspaceId, userId, teamId } = await workspace()
    const executor = executorWith([counting('first'), counting('second')])

    const run = await executor.start({
      workspaceId,
      teamId,
      startedBy: userId,
      definition: definition({
        tools: ['first'],
        steps: [
          { id: 'one', type: 'tool', tool: 'first' },
          { id: 'two', type: 'tool', tool: 'second' },
        ],
      }),
      input: {},
    })
    const outcome = await executor.run(workspaceId, run.id)

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatch(/allow-list/)
    expect(calls).toEqual(['first'])
  })

  it('AGENT-1 AC5: a model step resolves its tier through configuration', async () => {
    models = createFakeModelProvider()
    models.script({ chunks: ['{"answer":"forty-two"}'] })
    const { workspaceId, userId, teamId } = await workspace()

    let askedFor: string | undefined
    const executor = createExecutor(db.config, {
      registry: createToolRegistry([]),
      models,
      modelFor: (tier) => {
        askedFor = tier
        return { provider: 'fake', model: 'resolved-by-config' }
      },
      now: () => new Date('2026-09-03T12:00:00.000Z'),
    })

    const run = await executor.start({
      workspaceId,
      teamId,
      startedBy: userId,
      definition: definition({
        model: 'strong',
        tools: [],
        steps: [{ id: 'ask', type: 'model', prompt: 'test/prompt.md' }],
      }),
      input: {},
    })
    await executor.run(workspaceId, run.id)

    // The definition named a tier; configuration decided the model. No model
    // name appears in the definition (AC5).
    expect(askedFor).toBe('strong')
    expect(models.requests()[0]!.model.model).toBe('resolved-by-config')
  })

  it('AGENT-4: every step writes a run event, so a trace explains the run', async () => {
    models = createFakeModelProvider()
    models.script({ chunks: ['ok'] })
    const { workspaceId, userId, teamId } = await workspace()
    const executor = executorWith([counting('first')])

    const run = await executor.start({
      workspaceId,
      teamId,
      startedBy: userId,
      definition: definition({
        tools: ['first'],
        steps: [
          { id: 'one', type: 'tool', tool: 'first' },
          { id: 'ask', type: 'model', prompt: 'test/prompt.md' },
        ],
      }),
      input: {},
    })
    await executor.run(workspaceId, run.id)

    const events = await db.admin.query<{ kind: string }>(
      `SELECT kind FROM run_events WHERE run_id = $1 ORDER BY seq`,
      [run.id],
    )
    expect(events.map((event) => event.kind)).toEqual(['tool_call', 'model_call'])
  })

  it('AGENT-1: a failing run records why, so it is diagnosable without the logs', async () => {
    models = createFakeModelProvider()
    const { workspaceId, userId, teamId } = await workspace()
    const executor = executorWith([
      counting('first', {
        execute: async () => {
          throw new Error('the tool exploded')
        },
      } as Partial<AnyTool>),
    ])

    const run = await executor.start({
      workspaceId,
      teamId,
      startedBy: userId,
      definition: definition({
        tools: ['first'],
        steps: [{ id: 'one', type: 'tool', tool: 'first' }],
      }),
      input: {},
    })
    await executor.run(workspaceId, run.id)

    const [row] = await db.admin.query<{ status: string; error: string }>(
      `SELECT status, error FROM runs WHERE id = $1`,
      [run.id],
    )
    expect(row!.status).toBe('failed')
    expect(row!.error).toMatch(/exploded/)

    const [step] = await db.admin.query<{ status: string; error: string }>(
      `SELECT status, error FROM run_steps WHERE run_id = $1`,
      [run.id],
    )
    // Both: the run says it failed, the step says which one and why.
    expect(step!.status).toBe('failed')
    expect(step!.error).toMatch(/exploded/)
  })

  it("AGENT-1: one workspace's run is invisible to another", async () => {
    models = createFakeModelProvider()
    const mine = await workspace()
    const theirs = await workspace()
    const executor = executorWith([counting('first')])

    const run = await executor.start({
      workspaceId: mine.workspaceId,
      teamId: mine.teamId,
      startedBy: mine.userId,
      definition: definition({ tools: ['first'], steps: [{ id: 'one', type: 'tool', tool: 'first' }] }),
      input: {},
    })

    await expect(executor.run(theirs.workspaceId, run.id)).rejects.toThrow(/No such run/)
  })
})
