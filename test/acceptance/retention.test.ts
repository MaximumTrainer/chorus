import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { join } from 'node:path'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { WorkflowDefinitionSchema } from '@chorus/core'
import { createExecutor, createToolRegistry, type Executor } from '@chorus/agent'
import { loadPromptDirectory } from '@chorus/llm'
import { createApp } from '@chorus/api'
import { createRetentionPurge } from '@chorus/worker'
import {
  createFakeModelProvider,
  createRecordingMailer,
  createTestClient,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * NFR-4 AC3, WS-7 AC4 — retention purges each data class on its own schedule.
 *
 * Driven from the outside: an owner sets a period per class through the API,
 * the worker's purge runs at a given moment, and what remains is read back
 * through the trace and the audit log a member would use. The purge is told
 * the time rather than reading the clock, so "ten days later" is a value the
 * test chooses, measured from when the run actually happened.
 */
describe('NFR-4 retention', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let executor: Executor

  const DAY = 24 * 60 * 60 * 1000
  const BODY = 'a customer said something they would not want kept forever'

  const prompts = loadPromptDirectory(join(import.meta.dirname, '..', '..', 'workflows', 'prompts'))

  const definition = WorkflowDefinitionSchema.parse({
    name: 'retained-flow',
    version: 1,
    inputs: { workflows: 'the list offered', trigger: 'what arrived' },
    steps: [{ id: 'think', type: 'model', prompt: 'routing/classify' }],
  })

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    executor = createExecutor(db.config, {
      registry: createToolRegistry([]),
      models: createFakeModelProvider({ chunks: [BODY], usage: { inputTokens: 10, outputTokens: 20 } }),
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      prompts,
    })
    client = createTestClient(createApp({ dbConfig: db.config, mailer }), mailer)
  })

  interface Trace {
    run: { id: string; tokensOut: number; costCents: number }
    events: Array<{ kind: string; at: string; payload: Record<string, unknown> }>
  }

  /** A workspace that keeps bodies (`none`), with one finished run in it. */
  async function aWorkspaceWithARun(): Promise<{ ada: SignedInUser; workspaceId: string; runId: string }> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Retained')
    await ada.put(`/workspaces/${workspace.id}/redaction`, { level: 'none' })
    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{ id: string }>
    const run = await executor.start({
      workspaceId: workspace.id,
      teamId: teams[0]!.id,
      startedBy: ada.userId,
      definition,
      input: { workflows: '- shape-idea', trigger: '{"kind":"chat"}' },
    })
    await executor.run(workspace.id, run.id)
    return { ada, workspaceId: workspace.id, runId: run.id }
  }

  const traceOf = async (ada: SignedInUser, workspaceId: string, runId: string): Promise<Trace> => {
    const response = await ada.get(`/workspaces/${workspaceId}/runs/${runId}/trace`)
    expect(response.status, await response.clone().text()).toBe(200)
    return (await response.json()) as Trace
  }

  const setRetention = async (
    ada: SignedInUser,
    workspaceId: string,
    dataClass: string,
    days: number | null,
  ) => ada.put(`/workspaces/${workspaceId}/retention/${dataClass}`, { days })

  it('NFR-4 AC3: retention purges each data class on its own schedule and audits the purge', async () => {
    // Given a run whose prompt and response bodies were kept
    const { ada, workspaceId, runId } = await aWorkspaceWithARun()
    const before = await traceOf(ada, workspaceId, runId)
    const call = before.events.find((event) => event.kind === 'model_call')!
    expect(call.payload.response).toContain('would not want kept')
    const ranAt = Date.parse(call.at)

    // and an owner keeps prompts for 7 days and run traces for 30
    expect((await setRetention(ada, workspaceId, 'prompts', 7)).status).toBe(200)
    expect((await setRetention(ada, workspaceId, 'run_traces', 30)).status).toBe(200)

    const purge = createRetentionPurge({ dbConfig: db.config })

    // When the purge runs ten days later
    await purge.run(new Date(ranAt + 10 * DAY))

    // Then the prompt bodies are gone and the structural record of the call remains
    const tenDays = await traceOf(ada, workspaceId, runId)
    const purged = tenDays.events.find((event) => event.kind === 'model_call')!
    expect(purged.payload.prompt).toBeUndefined()
    expect(purged.payload.response).toBeUndefined()
    expect(JSON.stringify(tenDays)).not.toContain('would not want kept')
    expect(purged.payload).toMatchObject({ provider: 'fake', model: 'fake-1', tokensOut: 20 })
    expect(String(purged.payload.responseHash)).toMatch(/^[0-9a-f]{64}$/)

    // and the trace itself is still there, because its own period has not passed
    expect(tenDays.events).toHaveLength(before.events.length)

    // When the purge runs thirty-one days later
    await purge.run(new Date(ranAt + 31 * DAY))

    // Then the trace's events are gone, and the run's structural record survives
    const later = await traceOf(ada, workspaceId, runId)
    expect(later.events).toHaveLength(0)
    expect(later.run).toMatchObject({ id: runId, tokensOut: before.run.tokensOut })

    // and each purge is in the audit log, attributed to the system, naming its class
    const audit = (await (
      await ada.get(`/workspaces/${workspaceId}/audit?action=retention.purge`)
    ).json()) as { entries: Array<{ actorType: string; after: Record<string, unknown> }> }
    expect(audit.entries.map((entry) => entry.after.dataClass).sort()).toEqual(['prompts', 'run_traces'])
    expect(audit.entries.every((entry) => entry.actorType === 'system')).toBe(true)
  })

  it('NFR-4 AC3: an owner reads and sets each class, and the change is audited with both sides', async () => {
    // Given a new workspace, in which nothing is purged
    const ada = await client.signedInUser()
    const { id: workspaceId } = await ada.createWorkspace('Settings')
    expect(await (await ada.get(`/workspaces/${workspaceId}/retention`)).json()).toEqual({
      prompts: null,
      run_traces: null,
    })

    // When the owner sets a period, then clears it
    const set = await setRetention(ada, workspaceId, 'prompts', 14)
    expect(await set.json()).toEqual({ prompts: 14, run_traces: null })
    const cleared = await setRetention(ada, workspaceId, 'prompts', null)
    expect(await cleared.json()).toEqual({ prompts: null, run_traces: null })

    // Then both changes are in the audit log, each naming what it replaced
    const audit = (await (
      await ada.get(`/workspaces/${workspaceId}/audit?action=workspace.retention.set`)
    ).json()) as { entries: Array<{ actorId: string; before: unknown; after: unknown }> }
    expect(audit.entries.map(({ before, after }) => ({ before, after }))).toEqual(
      expect.arrayContaining([
        { before: { dataClass: 'prompts', days: null }, after: { dataClass: 'prompts', days: 14 } },
        { before: { dataClass: 'prompts', days: 14 }, after: { dataClass: 'prompts', days: null } },
      ]),
    )
    expect(audit.entries.every((entry) => entry.actorId === ada.userId)).toBe(true)
  })

  it('NFR-4 AC3: refuses a class Chorus does not hold and a period that is not whole days', async () => {
    const ada = await client.signedInUser()
    const { id: workspaceId } = await ada.createWorkspace('Refusals')

    expect((await setRetention(ada, workspaceId, 'screenshots', 7)).status).toBe(400)
    expect((await setRetention(ada, workspaceId, 'prompts', 0)).status).toBe(400)
    expect((await setRetention(ada, workspaceId, 'prompts', 1.5)).status).toBe(400)
    expect(await (await ada.get(`/workspaces/${workspaceId}/retention`)).json()).toEqual({
      prompts: null,
      run_traces: null,
    })
  })

  it('NFR-4 AC3: only an owner may set a period', async () => {
    // Given an admin who is not an owner
    const ada = await client.signedInUser()
    const { id: workspaceId } = await ada.createWorkspace('Owners only')
    const bob = await client.signedInUser()
    const invite = (await (
      await ada.post(`/workspaces/${workspaceId}/invitations`, { role: 'admin' })
    ).json()) as { token: string }
    expect((await bob.post('/invitations/accept', { token: invite.token })).status).toBe(200)

    // When they try to shorten a period, then they are refused and nothing changes
    expect((await setRetention(bob, workspaceId, 'run_traces', 1)).status).toBe(403)
    expect(await (await bob.get(`/workspaces/${workspaceId}/retention`)).json()).toMatchObject({
      run_traces: null,
    })
  })
})
