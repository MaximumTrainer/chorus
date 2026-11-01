import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { z } from 'zod'
import { ulid, WorkflowDefinitionSchema, type AnyTool, type WorkflowDefinition } from '@chorus/core'
import { createExecutor, createToolRegistry, type Executor } from '@chorus/agent'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type SignedInUser, type TestClient } from '@chorus/testing'

/**
 * NAV-3 — the review inbox.
 *
 * One list of everything blocking progress, grouped with counts (AC1), each
 * item carrying what a decider needs (AC2). Deciding applies the effect and the
 * item leaves the inbox (AC3); because the inbox reads the source tables, a
 * decision anywhere clears it here too (AC5). Bulk decides the low-risk kinds
 * and refuses merges and contradictions (AC4).
 */

const GATED: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  name: 'gated',
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

describe('NAV-3 review inbox', () => {
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
    executor = createExecutor(db.config, {
      registry: createToolRegistry([noop('prepare'), noop('act')]),
      models: undefined as never,
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

  async function world(): Promise<{ ada: SignedInUser; workspaceId: string; teamId: string }> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Inbox')
    const [team] = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{ id: string }>
    return { ada, workspaceId: workspace.id, teamId: team!.id }
  }

  async function raiseCheckpoint(w: Awaited<ReturnType<typeof world>>) {
    const run = await executor.start({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      startedBy: w.ada.userId,
      definition: GATED,
      input: {},
    })
    await executor.run(w.workspaceId, run.id)
  }

  async function seedConflict(w: Awaited<ReturnType<typeof world>>) {
    const integrationId = ulid()
    const taskId = ulid()
    await db.admin.execute(`INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'linear')`, [
      integrationId,
      w.workspaceId,
    ])
    await db.admin.execute(
      `INSERT INTO tasks (id, workspace_id, team_id, key, title, acceptance_criteria, created_by)
       VALUES ($1, $2, $3, $4, 'Conflicted task', '[]'::jsonb, $5)`,
      [taskId, w.workspaceId, w.teamId, `CH-${taskId.slice(-5)}`, w.ada.userId],
    )
    await db.admin.execute(
      `INSERT INTO task_tracker_links (id, workspace_id, task_id, integration_id, external_id, external_key, external_url, sync_state)
       VALUES ($1, $2, $3, $4, 'ext-1', 'ACME-1', 'https://x.test/ACME-1', 'conflict')`,
      [ulid(), w.workspaceId, taskId, integrationId],
    )
    return taskId
  }

  async function seedEntity(workspaceId: string, name: string): Promise<string> {
    const id = ulid()
    await db.admin.execute(
      `INSERT INTO entities (id, workspace_id, kind, external_id, name) VALUES ($1, $2, 'feature', $1, $3)`,
      [id, workspaceId, name],
    )
    return id
  }

  async function seedReviewItem(workspaceId: string, kind: string, subject: Record<string, unknown>): Promise<string> {
    const id = ulid()
    await db.admin.execute(
      `INSERT INTO brain_review_items (id, workspace_id, kind, subject) VALUES ($1, $2, $3, $4::jsonb)`,
      [id, workspaceId, kind, JSON.stringify(subject)],
    )
    return id
  }

  it('NAV-3 AC1/AC2: every blocking kind appears, grouped with counts and context', async () => {
    const w = await world()
    await raiseCheckpoint(w)
    await seedConflict(w)
    const winner = await seedEntity(w.workspaceId, 'Billing')
    const loser = await seedEntity(w.workspaceId, 'Biling')
    await seedReviewItem(w.workspaceId, 'merge', {
      winner: { entityId: winner, name: 'Billing' },
      loser: { entityId: loser, name: 'Biling' },
    })
    await seedReviewItem(w.workspaceId, 'contradiction', {
      claimA: { text: 'deprecated' },
      claimB: { text: 'recommended' },
    })
    await seedReviewItem(w.workspaceId, 'stale', { entity: { entityId: winner } })

    const body = (await (await w.ada.get(`/workspaces/${w.workspaceId}/teams/${w.teamId}/inbox`)).json()) as {
      groups: Array<{ kind: string; count: number; items: Array<{ context: Record<string, unknown> }> }>
    }
    const byKind = Object.fromEntries(body.groups.map((g) => [g.kind, g]))

    expect(byKind.checkpoint!.count).toBe(1)
    expect(byKind.sync_conflict!.count).toBe(1)
    expect(byKind.merge!.count).toBe(1)
    expect(byKind.contradiction!.count).toBe(1)
    expect(byKind.stale!.count).toBe(1)

    // Context is present to decide in place (AC2): both sides of the conflict,
    // both claims of the contradiction.
    expect(byKind.sync_conflict!.items[0]!.context).toMatchObject({
      local: { title: 'Conflicted task' },
      remote: { key: 'ACME-1' },
    })
    expect(byKind.contradiction!.items[0]!.context).toMatchObject({
      claimA: { text: 'deprecated' },
      claimB: { text: 'recommended' },
    })
  })

  it('NAV-3 AC3/AC5: accepting a merge consolidates the entities and the item leaves the inbox', async () => {
    const w = await world()
    const winner = await seedEntity(w.workspaceId, 'Billing')
    const loser = await seedEntity(w.workspaceId, 'Biling')
    const itemId = await seedReviewItem(w.workspaceId, 'merge', {
      winner: { entityId: winner, name: 'Billing' },
      loser: { entityId: loser, name: 'Biling' },
    })

    const decided = await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/inbox/decide`, {
      kind: 'merge',
      id: itemId,
      decision: 'accept',
    })
    expect(decided.status, await decided.clone().text()).toBe(200)
    expect((await decided.json()) as { applied: boolean }).toMatchObject({ applied: true })

    // The entities were consolidated (loser gone), and the item cleared.
    const remaining = await db.admin.query(`SELECT 1 FROM entities WHERE id = $1`, [loser])
    expect(remaining).toHaveLength(0)
    const body = (await (await w.ada.get(`/workspaces/${w.workspaceId}/teams/${w.teamId}/inbox`)).json()) as {
      groups: Array<{ kind: string; count: number }>
    }
    expect(body.groups.find((g) => g.kind === 'merge')!.count).toBe(0)
  })

  it('NAV-3 AC4: a bulk decision applies low-risk items and excludes merges and contradictions', async () => {
    const w = await world()
    const e = await seedEntity(w.workspaceId, 'Thing')
    const stale = await seedReviewItem(w.workspaceId, 'stale', { entity: { entityId: e } })
    const merge = await seedReviewItem(w.workspaceId, 'merge', { winner: { entityId: e }, loser: { entityId: e } })
    const contradiction = await seedReviewItem(w.workspaceId, 'contradiction', { claimA: {}, claimB: {} })

    const response = await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/inbox/bulk-decide`, {
      decisions: [
        { kind: 'stale', id: stale, decision: 'accept' },
        { kind: 'merge', id: merge, decision: 'accept' },
        { kind: 'contradiction', id: contradiction, decision: 'accept' },
      ],
    })
    expect(response.status, await response.clone().text()).toBe(200)
    const { outcomes } = (await response.json()) as { outcomes: Array<{ kind: string; outcome: string }> }
    const byKind = Object.fromEntries(outcomes.map((o) => [o.kind, o.outcome]))

    expect(byKind.stale).toBe('applied')
    expect(byKind.merge).toBe('excluded_high_risk')
    expect(byKind.contradiction).toBe('excluded_high_risk')

    // The stale item cleared; the high-risk ones are untouched and still open.
    const open = await db.admin.query<{ kind: string }>(
      `SELECT kind FROM brain_review_items WHERE workspace_id = $1 AND status = 'open'`,
      [w.workspaceId],
    )
    expect(open.map((r) => r.kind).sort()).toEqual(['contradiction', 'merge'])
  })
})
