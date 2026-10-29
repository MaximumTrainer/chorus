import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { z } from 'zod'
import { ulid, WorkflowDefinitionSchema, type AnyTool, type WorkflowDefinition } from '@chorus/core'
import { createExecutor, createToolRegistry, type Executor } from '@chorus/agent'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import {
  createFakeModelProvider,
  createRecordingMailer,
  createTestClient,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * NAV-2 — the team home.
 *
 * The home answers "what is happening and what needs me" in one screen: recent
 * sessions, proposals awaiting confirmation, the coding queue, and the
 * checkpoint inbox, each with an accurate count (AC1). What leaves a section
 * when it is handled must leave it on the next read too, including when the
 * action happened on another surface (AC3). The queue is visible to everyone,
 * but its launch actions are offered only to a role that may launch (AC5), and
 * each section shows a bounded set with the true total behind it (AC6).
 *
 * The live push that updates an open page without a reload (AC2) belongs to the
 * web surface and the pub/sub fan-out; this proves the read the surface renders
 * from, and that a handled item is gone the next time it is read.
 */

/** A workflow that stops at an `ask` gate, so a run leaves a pending checkpoint. */
const GATED: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  name: 'gated-flow',
  version: 1,
  tools: ['prepare', 'act'],
  steps: [
    { id: 'prepare', type: 'tool', tool: 'prepare' },
    { id: 'gate', type: 'checkpoint', kind: 'before_create_artefacts' },
    { id: 'act', type: 'tool', tool: 'act' },
  ],
})

const noop = (name: string): AnyTool =>
  ({
    name,
    description: name,
    input: z.object({}).passthrough(),
    output: z.object({ ran: z.string() }),
    sideEffect: 'none',
    requiredRole: 'member',
    requiredScopes: [],
    execute: async () => ({ ran: name }),
  }) as unknown as AnyTool

describe('NAV-2 team home', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let executor: Executor

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    const models = createFakeModelProvider()
    executor = createExecutor(db.config, {
      registry: createToolRegistry([noop('prepare'), noop('act')]),
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
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

  async function team(owner: SignedInUser): Promise<{ workspaceId: string; teamId: string }> {
    const workspace = await owner.createWorkspace('Home')
    const [t] = (await (await owner.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    return { workspaceId: workspace.id, teamId: t!.id }
  }

  async function startSession(user: SignedInUser, w: { workspaceId: string; teamId: string }): Promise<string> {
    const started = (await (
      await user.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/sessions`, { entryPoint: 'idea' })
    ).json()) as { id: string }
    return started.id
  }

  /** Insert the FK chain a coding job needs, and the job itself, in one state. */
  async function seedJob(
    w: { workspaceId: string; teamId: string },
    userId: string,
    status: string,
  ): Promise<string> {
    const integrationId = ulid()
    const repoId = ulid()
    const taskId = ulid()
    const jobId = ulid()
    await db.admin.execute(`INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'github')`, [
      integrationId,
      w.workspaceId,
    ])
    await db.admin.execute(
      `INSERT INTO repositories (id, workspace_id, team_id, integration_id, provider, full_name)
       VALUES ($1, $2, $3, $4, 'github', $5)`,
      [repoId, w.workspaceId, w.teamId, integrationId, `acme/${repoId.slice(-6).toLowerCase()}`],
    )
    await db.admin.execute(
      `INSERT INTO tasks (id, workspace_id, team_id, key, title, acceptance_criteria, created_by)
       VALUES ($1, $2, $3, $4, 'Split the parser', '[]'::jsonb, $5)`,
      [taskId, w.workspaceId, w.teamId, `CH-${taskId.slice(-5)}`, userId],
    )
    await db.admin.execute(
      `INSERT INTO coding_jobs (id, workspace_id, team_id, task_id, repository_id, adapter, status, branch, requested_by)
       VALUES ($1, $2, $3, $4, $5, 'reference', $6, $7, $8)`,
      [jobId, w.workspaceId, w.teamId, taskId, repoId, status, `chorus/${taskId.slice(-5)}`, userId],
    )
    return jobId
  }

  /** Run a gated workflow to its `ask` gate, leaving a pending checkpoint on the team. */
  async function raiseCheckpoint(
    owner: SignedInUser,
    w: { workspaceId: string; teamId: string },
  ): Promise<{ runId: string; checkpointId: string }> {
    const run = await executor.start({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      startedBy: owner.userId,
      definition: GATED,
      input: {},
    })
    await executor.run(w.workspaceId, run.id)
    const body = (await (await owner.get(`/workspaces/${w.workspaceId}/runs/${run.id}`)).json()) as {
      status: string
      checkpoint?: { id: string }
    }
    expect(body.status, 'the default policy is ask, so the run must wait').toBe('waiting_human')
    return { runId: run.id, checkpointId: body.checkpoint!.id }
  }

  it('NAV-2: the home shows recent sessions, pending proposals, the coding queue and checkpoints', async () => {
    const owner = await client.signedInUser()
    const w = await team(owner)

    // A session, with a proposal awaiting confirmation on it.
    const sessionId = await startSession(owner, w)
    const second = await startSession(owner, w)
    const proposed = await owner.post(`/workspaces/${w.workspaceId}/sessions/${sessionId}/proposals`, {
      tree: { nodes: [{ title: 'Parse' }, { title: 'Validate' }] },
    })
    expect(proposed.status, await proposed.clone().text()).toBe(201)

    // A running coding job, and an open checkpoint.
    await seedJob(w, owner.userId, 'running')
    const { checkpointId } = await raiseCheckpoint(owner, w)

    const response = await owner.get(`/workspaces/${w.workspaceId}/teams/${w.teamId}/home`)
    expect(response.status, await response.clone().text()).toBe(200)
    const home = (await response.json()) as {
      recentSessions: { items: Array<{ id: string }>; total: number }
      awaitingProposals: { items: Array<{ id: string }>; total: number }
      codingQueue: { items: Array<{ status: string }>; total: number; canLaunch: boolean }
      checkpoints: { items: Array<{ id: string }>; total: number }
    }

    // Each section is populated and its count accurate (AC1).
    expect(home.recentSessions.total).toBe(2)
    expect(home.recentSessions.items.map((s) => s.id).sort()).toEqual([sessionId, second].sort())

    expect(home.awaitingProposals.total).toBe(1)
    expect(home.awaitingProposals.items).toHaveLength(1)

    expect(home.codingQueue.total).toBe(1)
    expect(home.codingQueue.items[0]!.status).toBe('running')

    expect(home.checkpoints.total).toBe(1)
    expect(home.checkpoints.items.map((cp) => cp.id)).toEqual([checkpointId])
  })

  it('NAV-2: deciding a checkpoint elsewhere removes it from the home', async () => {
    const owner = await client.signedInUser()
    const w = await team(owner)
    const { checkpointId } = await raiseCheckpoint(owner, w)

    const before = (await (
      await owner.get(`/workspaces/${w.workspaceId}/teams/${w.teamId}/home`)
    ).json()) as { checkpoints: { total: number } }
    expect(before.checkpoints.total).toBe(1)

    // Decided on another surface — the decision route, not the home.
    const decided = await owner.post(`/workspaces/${w.workspaceId}/checkpoints/${checkpointId}/decision`, {
      decision: 'approve',
    })
    expect(decided.status, await decided.clone().text()).toBe(200)

    const after = (await (
      await owner.get(`/workspaces/${w.workspaceId}/teams/${w.teamId}/home`)
    ).json()) as { checkpoints: { items: unknown[]; total: number } }
    expect(after.checkpoints.total, 'a settled checkpoint leaves the inbox (AC3)').toBe(0)
    expect(after.checkpoints.items).toHaveLength(0)
  })

  it('NAV-2: the queue is visible to a member, but its launch actions are not offered (AC5)', async () => {
    const owner = await client.signedInUser()
    const w = await team(owner)
    await seedJob(w, owner.userId, 'running')
    const plain = await client.memberWithRole(owner, w.workspaceId, 'member')

    const asOwner = (await (
      await owner.get(`/workspaces/${w.workspaceId}/teams/${w.teamId}/home`)
    ).json()) as { codingQueue: { total: number; canLaunch: boolean } }
    const asMember = (await (
      await plain.get(`/workspaces/${w.workspaceId}/teams/${w.teamId}/home`)
    ).json()) as { codingQueue: { total: number; canLaunch: boolean } }

    // Both see the queue; only the role that may launch is offered the action.
    expect(asOwner.codingQueue.total).toBe(1)
    expect(asOwner.codingQueue.canLaunch).toBe(true)
    expect(asMember.codingQueue.total).toBe(1)
    expect(asMember.codingQueue.canLaunch).toBe(false)
  })

  it('NAV-2: a section bounds its items and reports the full total (AC6)', async () => {
    const owner = await client.signedInUser()
    const w = await team(owner)
    // More sessions than a section shows.
    for (let i = 0; i < 8; i += 1) await startSession(owner, w)

    const home = (await (
      await owner.get(`/workspaces/${w.workspaceId}/teams/${w.teamId}/home`)
    ).json()) as { recentSessions: { items: unknown[]; total: number } }

    expect(home.recentSessions.total, 'the true count is reported').toBe(8)
    expect(
      home.recentSessions.items.length,
      'the section shows a bounded set, not all of them',
    ).toBeLessThanOrEqual(5)
  })
})
