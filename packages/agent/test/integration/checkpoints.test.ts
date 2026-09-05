import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { z } from 'zod'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid, WorkflowDefinitionSchema, type AnyTool, type WorkflowDefinition } from '@chorus/core'
import { createFakeModelProvider, type FakeModelProvider } from '@chorus/testing'
import { createExecutor, expireCheckpoints, type Executor } from '../../src/executor.js'
import { decideCheckpoint } from '../../src/checkpoints.js'
import { createToolRegistry } from '../../src/registry.js'

/**
 * AGENT-3 — the gate itself, against a real database.
 *
 * The acceptance suite proves the journey a person takes. This proves the
 * properties only the database can show: that the policy tiers resolve from
 * stored rows, that a second decision cannot be applied even when it arrives
 * concurrently, and that an unanswered gate ends its run rather than holding it
 * open. Every assertion about a *gated action* counts executions at the tool,
 * because the run's own account of itself is exactly what is in question.
 */
describe('AGENT-3 checkpoints', () => {
  let db: IsolatedDatabase
  let models: FakeModelProvider
  let executor: Executor
  let calls: string[]

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
        calls.push(name)
        return { ran: name }
      },
    }) as unknown as AnyTool

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
    // The seed plants one of everything, this table included. Left in place it
    // would make "the run has one checkpoint" quietly false.
    await db.admin.execute(`DELETE FROM checkpoints WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM run_events WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM run_steps WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM runs WHERE workspace_id = $1`, [workspaceId])
    return { workspaceId, userId: member!.user_id, teamId: team!.id }
  }

  /** A run taken to its gate. */
  async function paused(
    overrides: Partial<WorkflowDefinition> = {},
  ): Promise<{ workspaceId: string; userId: string; teamId: string; runId: string }> {
    const world = await workspace()
    const run = await executor.start({
      workspaceId: world.workspaceId,
      teamId: world.teamId,
      startedBy: world.userId,
      definition: definition(overrides),
      input: {},
    })
    // Checked, not discarded. Every test below reads what the paused run left
    // behind, so a run that failed instead of pausing reports itself as an
    // empty table — "expected 0 to be 1" — and says nothing about why.
    const outcome = await executor.run(world.workspaceId, run.id)
    expect(outcome.status, `the run should have paused at the gate: ${outcome.error ?? ''}`).toBe(
      'waiting_human',
    )
    return { ...world, runId: run.id }
  }

  const checkpointOf = async (runId: string) => {
    const [row] = await db.admin.query<{
      id: string
      status: string
      kind: string
      policy_source: string
      payload: Record<string, unknown>
      expires_at: Date
    }>(`SELECT * FROM checkpoints WHERE run_id = $1`, [runId])
    return row
  }

  const statusOf = async (runId: string): Promise<{ status: string; error: string | null }> => {
    const [row] = await db.admin.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM runs WHERE id = $1`,
      [runId],
    )
    return row!
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    calls = []
    models = createFakeModelProvider()
    executor = createExecutor(db.config, {
      registry: createToolRegistry([counting('prepare'), counting('act')]),
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
    })
  })

  it('AGENT-3 AC1: the platform default is ask, so an unconfigured gate pauses', async () => {
    const { runId } = await paused()

    expect(await statusOf(runId)).toMatchObject({ status: 'waiting_human' })
    expect(await checkpointOf(runId)).toMatchObject({
      status: 'pending',
      kind: 'before_create_artefacts',
      // Nothing was configured, and the record says so rather than implying a
      // team chose this.
      policy_source: 'platform',
    })
    expect(calls, 'nothing past the gate may run').toEqual(['prepare'])
  })

  it('AGENT-3 AC1: a paused step is recorded as waiting, not as running', async () => {
    const { runId } = await paused()

    const [step] = await db.admin.query<{ status: string }>(
      `SELECT status FROM run_steps WHERE run_id = $1 AND step_id = 'gate'`,
      [runId],
    )
    // A paused run left as `running` is indistinguishable from a stuck one, and
    // "stuck" is what an operator is supposed to act on.
    expect(step).toMatchObject({ status: 'waiting' })
  })

  it('AGENT-3 AC2: a team policy of auto lets the run through without asking', async () => {
    const world = await workspace()
    await db.admin.execute(
      `INSERT INTO policies (id, workspace_id, team_id, checkpoint_kind, mode)
       VALUES ($1, $2, $3, 'before_create_artefacts', 'auto')`,
      [ulid(), world.workspaceId, world.teamId],
    )

    const run = await executor.start({
      workspaceId: world.workspaceId,
      teamId: world.teamId,
      startedBy: world.userId,
      definition: definition(),
      input: {},
    })
    const outcome = await executor.run(world.workspaceId, run.id)

    expect(outcome.status).toBe('succeeded')
    expect(calls).toEqual(['prepare', 'act'])
    // Still recorded. A gate passed automatically is a gate that was passed,
    // and a trace with no row for it cannot answer "who allowed this".
    expect(await checkpointOf(run.id)).toMatchObject({
      status: 'approved',
      policy_source: 'team',
    })
  })

  it('AGENT-3 AC2: the more specific team+workflow policy wins over the team one', async () => {
    const world = await workspace()
    await db.admin.execute(
      `INSERT INTO policies (id, workspace_id, team_id, checkpoint_kind, mode)
       VALUES ($1, $2, $3, 'before_create_artefacts', 'auto')`,
      [ulid(), world.workspaceId, world.teamId],
    )
    await db.admin.execute(
      `INSERT INTO policies (id, workspace_id, team_id, workflow_name, checkpoint_kind, mode)
       VALUES ($1, $2, $3, 'gated-flow', 'before_create_artefacts', 'ask')`,
      [ulid(), world.workspaceId, world.teamId],
    )

    const run = await executor.start({
      workspaceId: world.workspaceId,
      teamId: world.teamId,
      startedBy: world.userId,
      definition: definition(),
      input: {},
    })
    await executor.run(world.workspaceId, run.id)

    // The narrower rule tightened the gate, and the record names which tier did
    // it — a policy that surprises someone must be traceable to a row.
    expect(await checkpointOf(run.id)).toMatchObject({
      status: 'pending',
      policy_source: 'team+workflow',
    })
    expect(calls).toEqual(['prepare'])
  })

  it('AGENT-3 AC5: never stops the run and asks nobody', async () => {
    const world = await workspace()
    await db.admin.execute(
      `INSERT INTO policies (id, workspace_id, team_id, checkpoint_kind, mode)
       VALUES ($1, $2, $3, 'before_create_artefacts', 'never')`,
      [ulid(), world.workspaceId, world.teamId],
    )

    const run = await executor.start({
      workspaceId: world.workspaceId,
      teamId: world.teamId,
      startedBy: world.userId,
      definition: definition(),
      input: {},
    })
    const outcome = await executor.run(world.workspaceId, run.id)

    expect(outcome.status).toBe('stopped')
    const { status, error } = await statusOf(run.id)
    expect(status).toBe('stopped')
    // "A clear reason": the kind that stopped it and the policy that said so.
    expect(error).toMatch(/before_create_artefacts/)
    expect(error).toMatch(/never/)
    expect(calls).toEqual(['prepare'])

    // The whole of "asks nobody": there is no pending row for any surface to
    // notify about. A `never` gate that still created one would be a question
    // whose answer could not change anything.
    expect(await checkpointOf(run.id)).toBeUndefined()
  })

  it('AGENT-3 AC3: approve-with-edits resumes the run with the edited payload', async () => {
    const { workspaceId, runId, userId } = await paused()
    const checkpoint = await checkpointOf(runId)

    const settled = await decideCheckpoint(db.config, {
      workspaceId,
      checkpointId: checkpoint!.id,
      decidedBy: userId,
      decision: 'approve_with_edits',
      editedPayload: { proposed: { title: 'what the human actually allowed' } },
    })
    expect(settled.kind).toBe('settled')

    await executor.run(workspaceId, runId)
    expect(await statusOf(runId)).toMatchObject({ status: 'succeeded' })
    expect(calls).toEqual(['prepare', 'act'])

    // The step's output is what the human allowed, not what the agent proposed.
    const [step] = await db.admin.query<{ output: { payload: unknown; decision: string } }>(
      `SELECT output FROM run_steps WHERE run_id = $1 AND step_id = 'gate'`,
      [runId],
    )
    expect(step!.output).toMatchObject({
      decision: 'approve_with_edits',
      payload: { proposed: { title: 'what the human actually allowed' } },
    })

    // And the original survives beside it. The difference between what was
    // proposed and what was permitted is the record worth keeping.
    const after = await checkpointOf(runId)
    expect(after!.payload).toMatchObject({ step: 'gate' })
  })

  it('AGENT-3 AC4: a second decision is refused, not applied, even arriving at once', async () => {
    const { workspaceId, runId, userId } = await paused()
    const checkpoint = await checkpointOf(runId)

    // Two surfaces pressing at the same moment, which is the case a
    // read-then-write would get wrong.
    const [first, second] = await Promise.all([
      decideCheckpoint(db.config, {
        workspaceId,
        checkpointId: checkpoint!.id,
        decidedBy: userId,
        decision: 'approve',
      }),
      decideCheckpoint(db.config, {
        workspaceId,
        checkpointId: checkpoint!.id,
        decidedBy: userId,
        decision: 'reject',
      }),
    ])

    const outcomes = [first.kind, second.kind].sort()
    expect(outcomes, 'exactly one decision may take effect').toEqual(['already_settled', 'settled'])

    const after = await checkpointOf(runId)
    expect(['approved', 'rejected']).toContain(after!.status)

    // Whichever won, the losing decision left no trace of having been applied.
    const [row] = await db.admin.query<{ decision: string }>(
      `SELECT decision FROM checkpoints WHERE id = $1`,
      [checkpoint!.id],
    )
    expect(after!.status).toBe(row!.decision === 'reject' ? 'rejected' : 'approved')
  })

  it('AGENT-3 AC6: an expired checkpoint ends the run without performing the action', async () => {
    const { workspaceId, runId } = await paused()
    const checkpoint = await checkpointOf(runId)

    // Reach the deadline by moving it, not by waiting: a test that sleeps for a
    // real window is a test nobody runs.
    await db.admin.execute(`UPDATE checkpoints SET expires_at = now() - interval '1 minute'
                             WHERE id = $1`, [checkpoint!.id])

    const swept = await expireCheckpoints(db.config, { workspaceId })
    expect(swept).toBe(1)

    expect(await checkpointOf(runId)).toMatchObject({ status: 'expired' })
    const { status, error } = await statusOf(runId)
    expect(status).toBe('stopped')
    expect(error, 'the outcome must say why, not merely that it ended').toMatch(/expired/)

    // The point of AC6: ending safely means the gated action did not happen.
    expect(calls).toEqual(['prepare'])

    // And a resumption attempt afterwards must not quietly run it either.
    await executor.run(workspaceId, runId)
    expect(calls).toEqual(['prepare'])
  })

  it('AGENT-3 AC6: the sweep leaves a checkpoint inside its window alone', async () => {
    const { workspaceId, runId } = await paused()

    // Otherwise "expiry works" could be true because everything expires.
    expect(await expireCheckpoints(db.config, { workspaceId })).toBe(0)
    expect(await checkpointOf(runId)).toMatchObject({ status: 'pending' })
    expect(await statusOf(runId)).toMatchObject({ status: 'waiting_human' })
  })

  it('AGENT-3 AC3: rejecting stops the run rather than failing it', async () => {
    const { workspaceId, runId, userId } = await paused()
    const checkpoint = await checkpointOf(runId)

    await decideCheckpoint(db.config, {
      workspaceId,
      checkpointId: checkpoint!.id,
      decidedBy: userId,
      decision: 'reject',
      note: 'not this repository',
    })
    await executor.run(workspaceId, runId)

    const { status, error } = await statusOf(runId)
    // A person deciding "no" is the system working. Recording it as a failure
    // would put a healthy run in an error dashboard.
    expect(status).toBe('stopped')
    expect(error).toContain('not this repository')
    expect(calls).toEqual(['prepare'])
  })

  it('AGENT-3 AC7: a spend checkpoint carries the numbers the decision needs', async () => {
    const world = await workspace()
    await db.admin.execute(
      `INSERT INTO policies (id, workspace_id, team_id, checkpoint_kind, mode, spend_threshold_cents)
       VALUES ($1, $2, $3, 'before_spend_over', 'ask', 500)`,
      [ulid(), world.workspaceId, world.teamId],
    )

    const run = await executor.start({
      workspaceId: world.workspaceId,
      teamId: world.teamId,
      startedBy: world.userId,
      definition: definition({
        steps: [
          { id: 'prepare', type: 'tool', tool: 'prepare' },
          { id: 'gate', type: 'checkpoint', kind: 'before_spend_over' },
          { id: 'act', type: 'tool', tool: 'act' },
        ],
      }),
      input: {},
    })
    await db.admin.execute(`UPDATE runs SET cost_cents = 412 WHERE id = $1`, [run.id])
    await executor.run(world.workspaceId, run.id)

    const checkpoint = await checkpointOf(run.id)
    // All three, because "you have spent 412" without a threshold or an
    // estimate is not enough to answer with.
    expect(checkpoint!.payload).toMatchObject({
      spendSoFarCents: 412,
      thresholdCents: 500,
    })
    expect(
      (checkpoint!.payload as { estimatedRemainingCents?: number }).estimatedRemainingCents,
    ).toBeTypeOf('number')
  })

  it('AGENT-3: resuming an approved gate twice does not run the gated step twice', async () => {
    const { workspaceId, runId, userId } = await paused()
    const checkpoint = await checkpointOf(runId)
    await decideCheckpoint(db.config, {
      workspaceId,
      checkpointId: checkpoint!.id,
      decidedBy: userId,
      decision: 'approve',
    })

    // At-least-once delivery makes a duplicate resume ordinary, not exotic.
    await executor.run(workspaceId, runId)
    await executor.run(workspaceId, runId)

    expect(calls).toEqual(['prepare', 'act'])
  })

  it('AGENT-3: a decision writes its audit row in the same transaction', async () => {
    const { workspaceId, runId, userId } = await paused()
    const checkpoint = await checkpointOf(runId)

    await decideCheckpoint(db.config, {
      workspaceId,
      checkpointId: checkpoint!.id,
      decidedBy: userId,
      decision: 'approve',
    })

    const events = await db.admin.query<{
      actor_id: string
      action: string
      target_id: string
      before: { status: string }
      after: { status: string }
    }>(
      `SELECT actor_id, action, target_id, before, after FROM audit_events
        WHERE workspace_id = $1 AND target_type = 'checkpoint'`,
      [workspaceId],
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actor_id: userId,
      action: 'checkpoint.approve',
      target_id: checkpoint!.id,
      before: { status: 'pending' },
      after: { status: 'approved' },
    })
  })

  it('AGENT-3 AC4: the decision that lost the race leaves no audit row behind', async () => {
    const { workspaceId, runId, userId } = await paused()
    const checkpoint = await checkpointOf(runId)

    await Promise.all([
      decideCheckpoint(db.config, {
        workspaceId,
        checkpointId: checkpoint!.id,
        decidedBy: userId,
        decision: 'approve',
      }),
      decideCheckpoint(db.config, {
        workspaceId,
        checkpointId: checkpoint!.id,
        decidedBy: userId,
        decision: 'reject',
      }),
    ])

    // Exactly one. Two rows would show two people deciding the same gate, which
    // is precisely the story an audit log must not be able to tell — and it is
    // why the losing decision rolls its transaction back rather than returning
    // early after the audit row was already written.
    const events = await db.admin.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE workspace_id = $1 AND target_type = 'checkpoint'`,
      [workspaceId],
    )
    expect(events).toHaveLength(1)
  })

  it('AGENT-3: a checkpoint is recorded as a run event, so the trace shows the gate', async () => {
    const { runId } = await paused()

    const events = await db.admin.query<{ kind: string; payload: Record<string, unknown> }>(
      `SELECT kind, payload FROM run_events WHERE run_id = $1 AND kind = 'checkpoint'`,
      [runId],
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toMatchObject({ step: 'gate', mode: 'ask' })
  })
})
