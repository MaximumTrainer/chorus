import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid, WorkflowDefinitionSchema } from '@chorus/core'
import { createFakeModelProvider, type FakeModelProvider } from '@chorus/testing'
import { createExecutor, type Executor } from '../../src/executor.js'
import { createToolRegistry } from '../../src/registry.js'

/**
 * NFR-8 — the spend guard against a real database.
 *
 * The acceptance suite proves the journey. This proves the seam: that the
 * soft-limit checkpoint is an ordinary gate, so the team's stored policy for
 * `before_spend_over` decides it like any other, and that one approval holds
 * for the rest of the run rather than being asked again at every model step.
 */
describe('NFR-8 spend guard', () => {
  let db: IsolatedDatabase
  let models: FakeModelProvider
  let executor: Executor

  const NOW = new Date('2026-09-15T12:00:00Z')

  const twoCalls = WorkflowDefinitionSchema.parse({
    name: 'two-calls',
    version: 1,
    steps: [
      { id: 'first', type: 'model', prompt: 'first.md' },
      { id: 'second', type: 'model', prompt: 'second.md' },
    ],
  })

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    models = createFakeModelProvider()
    executor = createExecutor(db.config, {
      registry: createToolRegistry([]),
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      priceFor: (_model, usage) => usage.inputTokens,
      now: () => NOW,
    })
  })

  /** A workspace close to a soft limit, with nothing else in its way. */
  async function nearSoftLimit(): Promise<{ workspaceId: string; teamId: string; userId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    const [member] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    const [team] = await db.admin.query<{ id: string }>(
      `SELECT id FROM teams WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    // The seed plants a limit of its own; this test states the one it means.
    await db.admin.execute(`DELETE FROM spend_limits WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(
      `INSERT INTO spend_limits (id, workspace_id, period, soft_limit_cents)
       VALUES ($1, $2, 'month', 100)`,
      [ulid(), workspaceId],
    )
    await db.admin.execute(
      `INSERT INTO spend_ledger (id, workspace_id, provider, model, purpose, cost_cents, at)
       VALUES ($1, $2, 'fake', 'fake-1', 'chat', 99, '2026-09-10T00:00:00Z')`,
      [ulid(), workspaceId],
    )
    return { workspaceId, teamId: team!.id, userId: member!.user_id }
  }

  async function policy(teamId: string, workspaceId: string, mode: 'auto' | 'never'): Promise<void> {
    await db.admin.execute(
      `INSERT INTO policies (id, workspace_id, team_id, checkpoint_kind, mode)
       VALUES ($1, $2, $3, 'before_spend_over', $4)`,
      [ulid(), workspaceId, teamId, mode],
    )
  }

  async function run(w: { workspaceId: string; teamId: string; userId: string }) {
    const record = await executor.start({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      startedBy: w.userId,
      definition: twoCalls,
      input: {},
    })
    return { runId: record.id, outcome: await executor.run(w.workspaceId, record.id) }
  }

  it('NFR-8: a team whose policy is auto passes the soft limit, and the passing is recorded', async () => {
    const w = await nearSoftLimit()
    await policy(w.teamId, w.workspaceId, 'auto')

    const { runId, outcome } = await run(w)

    expect(outcome.status, outcome.error).toBe('succeeded')
    expect(models.requests()).toHaveLength(2)
    const gates = await db.admin.query<{ step_id: string; status: string; mode: string }>(
      `SELECT step_id, status, mode FROM checkpoints WHERE run_id = $1`,
      [runId],
    )
    // One, not two: the approval holds for the rest of the run.
    expect(gates).toEqual([{ step_id: 'first:spend_guard', status: 'approved', mode: 'auto' }])
  })

  it('NFR-8: a team whose policy is never is stopped at the soft limit with no call made', async () => {
    const w = await nearSoftLimit()
    await policy(w.teamId, w.workspaceId, 'never')

    const { outcome } = await run(w)

    expect(outcome.status).toBe('stopped')
    expect(outcome.error).toMatch(/before_spend_over/)
    expect(models.requests()).toHaveLength(0)
  })
})
