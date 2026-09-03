import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { join } from 'node:path'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { WorkflowDefinitionSchema } from '@chorus/core'
import { createExecutor, createToolRegistry, type Executor } from '@chorus/agent'
import { loadPromptDirectory } from '@chorus/llm'
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
 * NFR-11 / AGENT-4 AC3 — redaction, decided at write time.
 *
 * > Redaction is the control that makes such logging acceptable in
 * > environments that would otherwise forbid it entirely.
 *
 * Which is why it is applied *at write time* and not on read. A filter over
 * stored content is a promise that every future reader will remember to apply
 * it; a body that was never written cannot be leaked by a query somebody writes
 * next year, by a database dump, or by a backup restored somewhere else.
 *
 * The tests here therefore look at what is *in the database*, not at what the
 * API chooses to return.
 */
describe('NFR-11 redaction', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let executor: Executor
  let models: FakeModelProvider

  const prompts = loadPromptDirectory(
    join(import.meta.dirname, '..', '..', '..', '..', 'workflows', 'prompts'),
  )

  /**
   * Assembled from fragments, not written whole.
   *
   * It is invented, but it is shaped exactly like a real key — which is the
   * point of it — and a secret scanner cannot tell the difference. Written as a
   * literal it blocks the push, and teaches whoever hits that to reach for the
   * "allow this secret" button. See test/nfr/redaction.test.ts.
   */
  const LEAKED_KEY = ['sk-live', '-4c9a2f7b1e6d', '8a3c5f0b7e2d9a4c6f81'].join('')
  const SECRET_REPLY = `the answer involves ${LEAKED_KEY} somehow`

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    models = createFakeModelProvider({
      chunks: [SECRET_REPLY],
      usage: { inputTokens: 10, outputTokens: 20 },
    })
    executor = createExecutor(db.config, {
      registry: createToolRegistry([]),
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      prompts,
    })
    client = createTestClient(createApp({ dbConfig: db.config, mailer }), mailer)
  })

  const definition = WorkflowDefinitionSchema.parse({
    name: 'thinking-flow',
    version: 1,
    steps: [{ id: 'think', type: 'model', prompt: 'routing/classify' }],
  })

  async function runUnder(
    level?: 'none' | 'structural' | 'full',
  ): Promise<{ ada: SignedInUser; workspaceId: string; runId: string }> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Private')

    if (level) {
      const set = await ada.put(`/workspaces/${workspace.id}/redaction`, { level })
      expect(set.status, await set.clone().text()).toBe(200)
    }

    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    const run = await executor.start({
      workspaceId: workspace.id,
      teamId: teams[0]!.id,
      startedBy: ada.userId,
      definition,
      input: {},
    })
    await executor.run(workspace.id, run.id)
    return { ada, workspaceId: workspace.id, runId: run.id }
  }

  /** What is actually on disk, read past the API entirely. */
  const storedEvent = async (runId: string) => {
    const [row] = await db.admin.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'model_call'`,
      [runId],
    )
    return row!.payload
  }

  it('NFR-11 AC1: the default keeps the structure and not the bodies', async () => {
    const { runId } = await runUnder()
    const payload = await storedEvent(runId)

    // Structure intact — which model, which template, how much it cost. This is
    // what makes a trace useful without making it a liability.
    expect(payload).toMatchObject({ provider: 'fake', model: 'fake-1', promptVersion: 1 })
    expect(payload.tokensOut).toBe(20)

    // The body itself is not there. A hash of it is, so two runs can be shown
    // to have had the same input without the input being retained.
    expect(JSON.stringify(payload)).not.toContain('sk-live')
    expect(String(payload.responseHash)).toMatch(/^[0-9a-f]{64}$/)
    expect(payload.response).toBeUndefined()
  })

  it('NFR-11 AC1: at `none` the bodies are kept, because that is what was asked for', async () => {
    const { runId } = await runUnder('none')
    const payload = await storedEvent(runId)

    // A workspace may opt into full capture — it is their data and their
    // debugging. Otherwise every assertion above would hold just as well
    // against a system that never stored anything.
    expect(String(payload.response)).toContain('the answer involves')
  })

  it('NFR-11 AC5: even at `none`, credential-shaped content is never persisted', async () => {
    const { runId } = await runUnder('none')
    const payload = await storedEvent(runId)

    // The one rule no policy may switch off. A workspace can choose to keep its
    // prompts; nobody can choose to keep a leaked key, because the person whose
    // key it is did not get a say.
    expect(JSON.stringify(payload)).not.toContain(LEAKED_KEY)
    expect(String(payload.response)).toContain('[redacted]')
  })

  it('NFR-11 AC1: at `full` not even a hash of the body is kept', async () => {
    const { runId } = await runUnder('full')
    const payload = await storedEvent(runId)

    // A hash is still derived from content. For a workspace that has decided
    // nothing may be retained, "we only kept a fingerprint" is not an answer.
    expect(payload.response).toBeUndefined()
    expect(payload.responseHash).toBeUndefined()
    // And the structural record is still complete, which is the whole point of
    // the level existing at all rather than logging being switched off.
    expect(payload).toMatchObject({ provider: 'fake', model: 'fake-1' })
    expect(payload.tokensOut).toBe(20)
  })

  it('NFR-11 AC6: changing the policy does not reach backwards', async () => {
    const { ada, workspaceId, runId } = await runUnder('none')
    expect(String((await storedEvent(runId)).response)).toContain('the answer involves')

    const changed = await ada.put(`/workspaces/${workspaceId}/redaction`, { level: 'full' })
    expect(changed.status).toBe(200)

    // Unchanged. Retroactive redaction would be a rewrite of history, and a
    // trace that can be altered after the fact is not an audit record. Purging
    // old data is a separate, deliberate act (NFR-4 retention).
    expect(String((await storedEvent(runId)).response)).toContain('the answer involves')
  })

  it('NFR-11 AC6: the policy change is itself audited', async () => {
    const { ada, workspaceId } = await runUnder()
    await ada.put(`/workspaces/${workspaceId}/redaction`, { level: 'none' })

    const events = await db.admin.query<{ action: string; before: unknown; after: unknown }>(
      `SELECT action, before, after FROM audit_events
        WHERE workspace_id = $1 AND target_type = 'workspace_redaction'`,
      [workspaceId],
    )
    // Widening what is captured is exactly the change somebody would want to
    // make quietly, so it leaves a record naming both sides of it.
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      action: 'workspace.redaction.set',
      before: { level: 'structural' },
      after: { level: 'none' },
    })
  })

  it('NFR-11: setting the policy is an owner decision, not a member one', async () => {
    const { ada, workspaceId } = await runUnder()
    const bob = await client.memberWithRole(ada, workspaceId, 'member')

    expect((await bob.put(`/workspaces/${workspaceId}/redaction`, { level: 'none' })).status).toBe(
      403,
    )
  })

  it('NFR-11: an unknown level is refused rather than quietly defaulted', async () => {
    const { ada, workspaceId } = await runUnder()

    // Defaulting a typo to `structural` would be safe; defaulting it to `none`
    // would not, and a caller cannot tell which happened. Refusing is the only
    // answer that is the same in both directions.
    const response = await ada.put(`/workspaces/${workspaceId}/redaction`, { level: 'partial' })
    expect(response.status).toBe(400)
  })
})
