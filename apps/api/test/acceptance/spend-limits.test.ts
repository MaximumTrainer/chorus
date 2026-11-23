import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ulid, WorkflowDefinitionSchema } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createExecutor, createToolRegistry, type Executor } from '@chorus/agent'
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
 * WS-7 AC3 — an admin sets spend limits, and the guard enforces what they set.
 *
 * NFR-8 (#168) built the guard and proved it against limits arranged as rows,
 * because nothing could write them. This is the other half: the limits arrive
 * through the API an admin would use, and the proof that they took effect is
 * made where NFR-8 makes it — at the fake provider. A limit that reads back
 * correctly but does not stop a call is a setting, not a limit.
 *
 * Spend already on the ledger is still arranged as rows: earlier calls would
 * have left it, and reproducing a month of model calls to reach a figure would
 * test the ledger, not the limit.
 */
describe('WS-7 spend limits', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let models: FakeModelProvider
  let executor: Executor

  /** The middle of a month, so "this period" is unambiguous. */
  const NOW = new Date('2026-09-15T12:00:00Z')

  /** One cent per input token: any real prompt costs something to send. */
  const priceFor = (_model: unknown, usage: { inputTokens: number }) => usage.inputTokens

  const definition = WorkflowDefinitionSchema.parse({
    name: 'limited-flow',
    version: 1,
    steps: [{ id: 'answer', type: 'model', prompt: 'reply.md' }],
  })

  interface World {
    ada: SignedInUser
    workspaceId: string
    teamId: string
  }

  interface Limit {
    teamId: string | null
    period: 'day' | 'month'
    softLimitCents: number | null
    hardLimitCents: number | null
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    models = createFakeModelProvider()
    const mailer = createRecordingMailer()
    executor = createExecutor(db.config, {
      registry: createToolRegistry([]),
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

  const setWorkspaceLimit = (who: SignedInUser, workspaceId: string, body: Record<string, unknown>) =>
    who.put(`/workspaces/${workspaceId}/spend-limit`, body)

  const setTeamLimit = (
    who: SignedInUser,
    workspaceId: string,
    teamId: string,
    body: Record<string, unknown>,
  ) => who.put(`/workspaces/${workspaceId}/teams/${teamId}/spend-limit`, body)

  const limits = async (who: SignedInUser, workspaceId: string): Promise<Limit[]> => {
    const response = await who.get(`/workspaces/${workspaceId}/spend-limits`)
    expect(response.status, await response.clone().text()).toBe(200)
    return (await response.json()) as Limit[]
  }

  /** Spend already on the ledger, as earlier calls would have left it. */
  async function spent(w: World, cents: number, teamId: string | null = w.teamId): Promise<void> {
    await db.admin.execute(
      `INSERT INTO spend_ledger
         (id, workspace_id, team_id, provider, model, purpose, cost_cents, at)
       VALUES ($1, $2, $3, 'fake', 'fake-1', 'chat', $4, '2026-09-10T09:00:00Z')`,
      [ulid(), w.workspaceId, teamId, cents],
    )
  }

  async function runIt(w: World) {
    const record = await executor.start({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      startedBy: w.ada.userId,
      definition,
      input: {},
    })
    return { runId: record.id, outcome: await executor.run(w.workspaceId, record.id) }
  }

  it('WS-7 AC3: a soft limit an admin sets raises before_spend_over before the provider is called', async () => {
    // Given an admin has set a monthly soft limit the workspace is about to cross
    const w = await world()
    const admin = await client.memberWithRole(w.ada, w.workspaceId, 'admin')
    const set = await setWorkspaceLimit(admin, w.workspaceId, { period: 'month', softLimitCents: 100 })
    expect(set.status, await set.clone().text()).toBe(200)
    await spent(w, 99)

    // When a model-calling run is considered
    const { runId, outcome } = await runIt(w)

    // Then it waits on a spend checkpoint, and the provider saw nothing
    expect(outcome.status, outcome.error).toBe('waiting_human')
    expect(models.requests()).toHaveLength(0)
    const view = (await (await w.ada.get(`/workspaces/${w.workspaceId}/runs/${runId}`)).json()) as {
      checkpoint: { id: string }
    }
    const checkpoint = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/checkpoints/${view.checkpoint.id}`)
    ).json()) as { kind: string; payload: Record<string, unknown> }
    expect(checkpoint.kind).toBe('before_spend_over')
    expect(checkpoint.payload).toMatchObject({ scope: 'workspace', softLimitCents: 100 })

    // and on approval the work continues, with exactly one call
    const decided = await w.ada.post(
      `/workspaces/${w.workspaceId}/checkpoints/${view.checkpoint.id}/decision`,
      { decision: 'approve' },
    )
    expect(decided.status, await decided.clone().text()).toBe(200)
    expect(models.requests()).toHaveLength(1)
  })

  it('WS-7 AC3: a hard limit an admin sets fails new runs with an actionable error, and no call is made', async () => {
    // Given an admin has set a hard limit the workspace is already over
    const w = await world()
    const set = await setWorkspaceLimit(w.ada, w.workspaceId, { period: 'month', hardLimitCents: 100 })
    expect(set.status, await set.clone().text()).toBe(200)
    await spent(w, 150)

    // When a new run starts
    const { outcome } = await runIt(w)

    // Then it fails, saying which limit, how much and for which period
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatch(/workspace hard spend limit/i)
    expect(outcome.error).toContain('100')
    expect(outcome.error).toContain('2026-09-01')
    expect(models.requests()).toHaveLength(0)
  })

  it("WS-7 AC3: a team's limit binds that team's runs inside a workspace with none", async () => {
    const w = await world()
    const set = await setTeamLimit(w.ada, w.workspaceId, w.teamId, { hardLimitCents: 100 })
    expect(set.status, await set.clone().text()).toBe(200)
    await spent(w, 150)

    const { outcome } = await runIt(w)

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatch(/team hard spend limit/i)
    expect(models.requests()).toHaveLength(0)
  })

  it('WS-7: limits read back as set, a period defaults to the month, and clearing one removes it', async () => {
    const w = await world()
    expect(await limits(w.ada, w.workspaceId)).toEqual([])

    await setWorkspaceLimit(w.ada, w.workspaceId, { softLimitCents: 5_000, hardLimitCents: 10_000 })
    await setTeamLimit(w.ada, w.workspaceId, w.teamId, { period: 'day', softLimitCents: 300 })

    expect(await limits(w.ada, w.workspaceId)).toEqual([
      { teamId: null, period: 'month', softLimitCents: 5_000, hardLimitCents: 10_000 },
      { teamId: w.teamId, period: 'day', softLimitCents: 300, hardLimitCents: null },
    ])

    // Replacing is a whole replacement, not a merge: what is omitted is unset.
    const replaced = await setWorkspaceLimit(w.ada, w.workspaceId, { hardLimitCents: 20_000 })
    expect(await replaced.json()).toEqual({
      teamId: null,
      period: 'month',
      softLimitCents: null,
      hardLimitCents: 20_000,
    })

    // A limit that limits nothing is no limit, so setting neither removes it.
    const cleared = await setTeamLimit(w.ada, w.workspaceId, w.teamId, {
      softLimitCents: null,
      hardLimitCents: null,
    })
    expect(cleared.status, await cleared.clone().text()).toBe(200)
    expect(await limits(w.ada, w.workspaceId)).toEqual([
      { teamId: null, period: 'month', softLimitCents: null, hardLimitCents: 20_000 },
    ])

    // And with no limit the team's runs are not gated.
    await spent(w, 1_000)
    const { outcome } = await runIt(w)
    expect(outcome.status, outcome.error).toBe('succeeded')
  })

  it('WS-7: each change is audited with what it replaced', async () => {
    const w = await world()
    await setWorkspaceLimit(w.ada, w.workspaceId, { hardLimitCents: 100 })
    await setWorkspaceLimit(w.ada, w.workspaceId, { hardLimitCents: 1_000_000 })

    const audit = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/audit?action=workspace.spend_limit.set`)
    ).json()) as { entries: Array<{ actorId: string; before: unknown; after: unknown }> }

    // Raising a hard limit is exactly the change somebody would make quietly.
    expect(audit.entries.map(({ before, after }) => ({ before, after }))).toEqual(
      expect.arrayContaining([
        {
          before: null,
          after: { teamId: null, period: 'month', softLimitCents: null, hardLimitCents: 100 },
        },
        {
          before: { teamId: null, period: 'month', softLimitCents: null, hardLimitCents: 100 },
          after: { teamId: null, period: 'month', softLimitCents: null, hardLimitCents: 1_000_000 },
        },
      ]),
    )
    expect(audit.entries).toHaveLength(2)
    expect(audit.entries.every((entry) => entry.actorId === w.ada.userId)).toBe(true)
  })

  it('WS-7: a senior member may not set a limit, and nothing changes', async () => {
    const w = await world()
    const senior = await client.memberWithRole(w.ada, w.workspaceId, 'senior_member')

    expect((await setWorkspaceLimit(senior, w.workspaceId, { hardLimitCents: 1 })).status).toBe(403)
    expect((await setTeamLimit(senior, w.workspaceId, w.teamId, { hardLimitCents: 1 })).status).toBe(403)
    expect(await limits(w.ada, w.workspaceId)).toEqual([])
  })

  it('WS-7: a limit that could not be enforced as written is refused, naming the field', async () => {
    const w = await world()

    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ hardLimitCents: -1 }, 'hardLimitCents'],
      [{ softLimitCents: 1.5 }, 'softLimitCents'],
      [{ softLimitCents: '100' }, 'softLimitCents'],
      [{ period: 'week', hardLimitCents: 100 }, 'period'],
      // A soft limit above the hard one would never be asked about.
      [{ softLimitCents: 200, hardLimitCents: 100 }, 'softLimitCents'],
    ]
    for (const [body, field] of refusals) {
      const response = await setWorkspaceLimit(w.ada, w.workspaceId, body)
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(JSON.stringify(await response.json()), JSON.stringify(body)).toContain(field)
    }
    expect(await limits(w.ada, w.workspaceId)).toEqual([])
  })

  it("WS-7: another workspace's team is not found", async () => {
    const w = await world()
    const other = await world()

    const response = await setTeamLimit(w.ada, w.workspaceId, other.teamId, { hardLimitCents: 100 })

    expect(response.status).toBe(404)
    expect(await limits(other.ada, other.workspaceId)).toEqual([])
  })
})
