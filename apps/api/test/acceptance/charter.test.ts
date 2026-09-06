import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid, WorkflowDefinitionSchema } from '@chorus/core'
import { createExecutor, createToolRegistry } from '@chorus/agent'
import { createFakeModelProvider, type FakeModelProvider } from '@chorus/testing'

/**
 * WS-3 AC2 — the charter is context every agent turn works from.
 *
 * `architecture.md` §6 calls the charter "always injected into agent context",
 * and §10 puts it in the stable prefix that is assembled first. Until now it
 * was stored, bounded and editable, and reached nothing: a team could write
 * "never suggest a paid dependency" and every agent turn would carry on as if
 * it had not.
 *
 * Both halves are asserted, because the second is the one that is easy to
 * leave out. A charter that reaches the prompt but not the trace makes every
 * later "why did the agent do that?" unanswerable — the reader can see what the
 * model said and not what it was told.
 */
describe('WS-3 team charter in agent context', () => {
  let db: IsolatedDatabase
  let models: FakeModelProvider

  const CHARTER = 'Never suggest a paid dependency. Our users self-host on one box.'

  interface World {
    workspaceId: string
    userId: string
    teamId: string
  }

  async function world(charter?: string): Promise<World> {
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
    if (charter !== undefined) {
      await db.admin.execute(`UPDATE teams SET charter = $1 WHERE id = $2`, [charter, team!.id])
    }
    return { workspaceId, userId: member!.user_id, teamId: team!.id }
  }

  /** One agent turn for a team: the smallest workflow that calls a model. */
  async function aTurn(w: World): Promise<string> {
    const executor = createExecutor(db.config, {
      registry: createToolRegistry([]),
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
    })
    const run = await executor.start({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      startedBy: w.userId,
      definition: WorkflowDefinitionSchema.parse({
        name: 'a-turn',
        version: 1,
        steps: [{ id: 'answer', type: 'model', prompt: 'reply.md' }],
      }),
      input: { question: 'which queue should we add?' },
    })
    const outcome = await executor.run(w.workspaceId, run.id)
    expect(outcome.status, `the turn should have succeeded: ${outcome.error ?? ''}`).toBe(
      'succeeded',
    )
    return run.id
  }

  const modelCallPayload = async (runId: string): Promise<Record<string, unknown>> => {
    const [event] = await db.admin.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'model_call' ORDER BY seq LIMIT 1`,
      [runId],
    )
    return event!.payload
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    models = createFakeModelProvider()
  })

  it("WS-3 AC2: a team charter constraint is visible in the agent's assembled context", async () => {
    // Given a team whose charter states a specific constraint
    const w = await world(CHARTER)

    // When any agent turn runs for that team
    const runId = await aTurn(w)

    // Then the charter appears in the assembled prompt
    const [request] = models.requests()
    expect(request!.prompt).toContain(CHARTER)

    // and the run's recorded context includes it, so a reader of the trace can
    // see what the model was told and not only what it said
    const payload = await modelCallPayload(runId)
    expect(JSON.stringify(payload)).toContain(CHARTER)
  })

  it('WS-3 AC2: the charter is assembled before the volatile context', async () => {
    // Given the same team
    const w = await world(CHARTER)

    // When a turn runs
    await aTurn(w)

    // Then the charter leads. `architecture.md` §10 assembles the stable prefix
    // first precisely so a provider can cache it; a charter appended after the
    // volatile part is a prefix that changes on every call and caches nothing.
    const [request] = models.requests()
    // Asserted present before asserting position: a missing charter has index
    // -1, which is "before" everything and would pass this test by absence.
    expect(request!.prompt).toContain(CHARTER)
    expect(request!.prompt.indexOf(CHARTER)).toBeLessThan(request!.prompt.indexOf('reply.md'))
  })

  it('WS-3 AC2: the charter stays answerable when the workspace keeps no bodies', async () => {
    // Given a workspace that has chosen to retain nothing of a prompt
    const w = await world(CHARTER)
    await db.admin.execute(`UPDATE workspaces SET redaction_level = 'full' WHERE id = $1`, [
      w.workspaceId,
    ])

    // When a turn runs
    const runId = await aTurn(w)

    // Then the body really is gone — the workspace's choice is honoured —
    const payload = await modelCallPayload(runId)
    expect(payload.prompt).toBeUndefined()
    expect(payload.promptHash).toBeUndefined()

    // and the charter is still there, beside the model and the template
    // version, because it is configuration rather than the content §11.6
    // exists to keep out. Otherwise the one input that applies to every turn
    // is the one input no trace can show.
    expect(payload.teamCharter).toBe(CHARTER)
  })

  it('WS-3 AC2: a team with no charter contributes no empty preamble', async () => {
    // Given a team that has not written a charter — the default for every new
    // workspace, so this is the ordinary case and not an edge one
    const w = await world()

    // When a turn runs
    await aTurn(w)

    // Then the prompt is what the workflow asked for, with no heading standing
    // over nothing. An empty section is not free: it is tokens on every call,
    // and it teaches a model that the section is usually worthless.
    const [request] = models.requests()
    expect(request!.prompt).toBe(`reply.md\n\n${JSON.stringify({ question: 'which queue should we add?' })}`)
  })
})
