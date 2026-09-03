import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { z } from 'zod'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid, WorkflowDefinitionSchema, type AnyTool, type WorkflowDefinition } from '@chorus/core'
import { createFakeModelProvider } from '@chorus/testing'
import { createExecutor, type Executor } from '../../src/executor.js'
import { createToolRegistry } from '../../src/registry.js'

/**
 * AGENT-1 — `branch` and `loop`, the last two step types (plan.md §2.1 step 6).
 *
 * Control flow is where an engine most easily becomes untrustworthy, because
 * both failures are silent. A branch that runs the arm it should have skipped
 * does work nobody asked for; a loop that repeats a completed iteration on
 * resume duplicates whatever that iteration wrote. Neither shows up in a status
 * field — the run says "succeeded" either way. So every test here counts
 * executions at the tool, and names the step it expects to have been skipped.
 */
describe('AGENT-1 control flow', () => {
  let db: IsolatedDatabase
  let executor: Executor
  let calls: string[]

  const counting = (name: string): AnyTool =>
    ({
      name,
      description: name,
      input: z.object({}).passthrough(),
      output: z.object({}).passthrough(),
      sideEffect: 'none',
      requiredRole: 'member',
      requiredScopes: [],
      execute: async (input: Record<string, unknown>) => {
        // Recorded with its input, so "the body saw the current item" is a
        // question about what actually reached the tool.
        calls.push(input && 'item' in input ? `${name}:${JSON.stringify(input.item)}` : name)
        return { ran: name, saw: input }
      },
    }) as unknown as AnyTool

  /** Yields a fixed collection, so a loop has something real to iterate. */
  const yielding = (name: string, value: unknown): AnyTool =>
    ({
      name,
      description: name,
      input: z.object({}).passthrough(),
      output: z.object({}).passthrough(),
      sideEffect: 'none',
      requiredRole: 'member',
      requiredScopes: [],
      execute: async () => {
        calls.push(name)
        return value as Record<string, unknown>
      },
    }) as unknown as AnyTool

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
    await db.admin.execute(`DELETE FROM checkpoints WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM run_events WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM run_steps WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM runs WHERE workspace_id = $1`, [workspaceId])
    return { workspaceId, userId: member!.user_id, teamId: team!.id }
  }

  async function runWith(
    definition: WorkflowDefinition,
  ): Promise<{ workspaceId: string; runId: string; status: string }> {
    const world = await workspace()
    const run = await executor.start({
      workspaceId: world.workspaceId,
      teamId: world.teamId,
      startedBy: world.userId,
      definition,
      input: {},
    })
    const outcome = await executor.run(world.workspaceId, run.id)
    return { workspaceId: world.workspaceId, runId: run.id, status: outcome.status }
  }

  const stepRows = async (runId: string) =>
    db.admin.query<{ step_id: string; status: string; seq: number }>(
      `SELECT step_id, status, seq FROM run_steps WHERE run_id = $1 ORDER BY seq`,
      [runId],
    )

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    calls = []
    executor = createExecutor(db.config, {
      registry: createToolRegistry([
        yielding('decide_true', { ok: true }),
        yielding('decide_false', { ok: false }),
        yielding('two_items', { items: ['alpha', 'beta'] }),
        yielding('no_items', { items: [] }),
        yielding('many_items', { items: Array.from({ length: 9 }, (_, i) => i) }),
        counting('on_true'),
        counting('on_false'),
        counting('body'),
        counting('after'),
      ]),
      models: createFakeModelProvider(),
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
    })
  })

  const branching = (source: string): WorkflowDefinition =>
    WorkflowDefinitionSchema.parse({
      name: 'branching',
      version: 1,
      tools: [source, 'on_true', 'on_false', 'after'],
      steps: [
        { id: 'decide', type: 'tool', tool: source },
        {
          id: 'pick',
          type: 'branch',
          when: '{{decide.output}}',
          then: ['on_true'],
          otherwise: ['on_false'],
        },
        { id: 'on_true', type: 'tool', tool: 'on_true' },
        { id: 'on_false', type: 'tool', tool: 'on_false' },
        { id: 'after', type: 'tool', tool: 'after' },
      ],
    })

  it('AGENT-1: a branch runs the arm it took and does not run the other', async () => {
    const { status } = await runWith(branching('decide_true'))

    expect(status).toBe('succeeded')
    // `after` is outside both arms and must still run: a branch chooses between
    // arms, it does not end the workflow.
    expect(calls).toEqual(['decide_true', 'on_true', 'after'])
  })

  it('AGENT-1: a falsy condition takes the other arm', async () => {
    const { status } = await runWith(branching('decide_false'))

    expect(status).toBe('succeeded')
    expect(calls).toEqual(['decide_false', 'on_false', 'after'])
  })

  it('AGENT-1: the arm not taken is recorded as skipped, so a trace shows the path', async () => {
    const { runId } = await runWith(branching('decide_true'))

    const rows = await stepRows(runId)
    const byId = new Map(rows.map((r) => [r.step_id, r.status]))
    // Absent would mean the trace cannot distinguish "did not run" from "was
    // never in the definition", and the second is a much worse answer to give
    // someone reading a run months later.
    expect(byId.get('on_false')).toBe('skipped')
    expect(byId.get('on_true')).toBe('succeeded')
  })

  it('AGENT-1 AC2: resuming after a branch does not re-run the arm it took', async () => {
    const world = await workspace()
    const run = await executor.start({
      workspaceId: world.workspaceId,
      teamId: world.teamId,
      startedBy: world.userId,
      definition: branching('decide_true'),
      input: {},
    })
    await executor.run(world.workspaceId, run.id)
    const first = [...calls]

    // At-least-once delivery makes a second run of the same job ordinary.
    await executor.run(world.workspaceId, run.id)

    expect(calls, 'a resumed branch must re-decide nothing and re-run nothing').toEqual(first)
  })

  const looping = (source: string, maxIterations = 20): WorkflowDefinition =>
    WorkflowDefinitionSchema.parse({
      name: 'looping',
      version: 1,
      tools: [source, 'body', 'after'],
      steps: [
        { id: 'collect', type: 'tool', tool: source },
        {
          id: 'each',
          type: 'loop',
          over: '{{collect.output}}',
          body: ['body'],
          maxIterations,
        },
        { id: 'body', type: 'tool', tool: 'body', input: { item: '{{each.item}}' } },
        { id: 'after', type: 'tool', tool: 'after' },
      ],
    })

  it('AGENT-1: a loop runs its body once per item, in order, and the body sees each item', async () => {
    const { status } = await runWith(looping('two_items'))

    expect(status).toBe('succeeded')
    expect(calls).toEqual(['two_items', 'body:"alpha"', 'body:"beta"', 'after'])
  })

  it('AGENT-1: a loop body step is not also run by the main sequence', async () => {
    // The body ids appear in `steps` like any other. Running them once for the
    // loop and again in sequence is the obvious implementation and is wrong.
    const { runId } = await runWith(looping('two_items'))

    const bodies = calls.filter((c) => c.startsWith('body'))
    expect(bodies).toHaveLength(2)

    const rows = await stepRows(runId)
    // One row per iteration, distinctly identified, because resumption matches
    // by step id and two iterations sharing one id could not be told apart.
    const iterationRows = rows.filter((r) => r.step_id.startsWith('body#'))
    expect(iterationRows.map((r) => r.step_id)).toEqual(['body#0', 'body#1'])
  })

  it('AGENT-1: an empty collection runs the body no times, and the run still succeeds', async () => {
    const { status } = await runWith(looping('no_items'))

    // Not an error. Nothing to do is a legitimate outcome, and failing here
    // would make every workflow guard its own loops.
    expect(status).toBe('succeeded')
    expect(calls).toEqual(['no_items', 'after'])
  })

  it('AGENT-1: maxIterations bounds a loop, and the run fails rather than truncating silently', async () => {
    const { status, runId } = await runWith(looping('many_items', 3))

    // A collection a model produced has no natural end. Quietly processing the
    // first three of nine would be a wrong answer presented as a right one.
    expect(status).toBe('failed')
    const [row] = await db.admin.query<{ error: string }>(`SELECT error FROM runs WHERE id = $1`, [
      runId,
    ])
    expect(row!.error).toMatch(/maxIterations|iteration/i)
    // None, not the first three. The bound is checked before the first
    // iteration, so an over-long collection leaves no partial work behind to
    // reconcile — which matters most for the loops that write something.
    expect(calls.filter((c) => c.startsWith('body'))).toHaveLength(0)
  })

  it('AGENT-1 AC2: a loop interrupted midway does not repeat completed iterations', async () => {
    const world = await workspace()
    const run = await executor.start({
      workspaceId: world.workspaceId,
      teamId: world.teamId,
      startedBy: world.userId,
      definition: looping('two_items'),
      input: {},
    })
    await executor.run(world.workspaceId, run.id)

    // Kill the run after the loop finished but before the workflow did, then
    // resume: the completed iterations must not run a second time.
    await db.admin.execute(`UPDATE runs SET status = 'running' WHERE id = $1`, [run.id])
    await db.admin.execute(
      `DELETE FROM run_steps WHERE run_id = $1 AND step_id = 'after'`,
      [run.id],
    )
    calls = []

    await executor.run(world.workspaceId, run.id)

    expect(calls, 'only the step that had not completed may run').toEqual(['after'])
  })
})
