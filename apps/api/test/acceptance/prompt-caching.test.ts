import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ulid, WorkflowDefinitionSchema } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createExecutor, createToolRegistry } from '@chorus/agent'
import { createFakeModelProvider, type FakeModelProvider } from '@chorus/testing'

/**
 * NFR-8 — cached tokens, and the bill that depends on counting them apart.
 *
 * `architecture.md` §9.3 says prompt-prefix caching "is used where the provider
 * supports it", and that the stable prefix is assembled first with the volatile
 * context last. Neither was implemented.
 *
 * The half that is a correctness problem rather than a saving is the ledger. A
 * cache read costs roughly a tenth of a fresh input token. Recorded as ordinary
 * input, every cached run is billed to the workspace at up to ten times what it
 * cost — and NFR-8 AC2's per-run cost display, which must reconcile exactly
 * against the ledger, then reconciles perfectly with a wrong number. Nobody
 * downstream can tell, because the row is internally consistent.
 */
describe('NFR-8 prompt caching and the ledger', () => {
  let db: IsolatedDatabase
  let models: FakeModelProvider

  interface World {
    workspaceId: string
    teamId: string
    userId: string
  }

  async function world(): Promise<World> {
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
    return { workspaceId, teamId: team!.id, userId: member!.user_id }
  }

  const definition = WorkflowDefinitionSchema.parse({
    name: 'answering-flow',
    version: 1,
    steps: [{ id: 'answer', type: 'model', prompt: 'reply.md' }],
  })

  /** Hundredths of a cent per million tokens, as `ModelCost` carries them. */
  const PRICES = {
    inputPerMillion: 500_000,
    outputPerMillion: 2_500_000,
    cachedInputPerMillion: 50_000,
  }

  async function run(w: World) {
    const executor = createExecutor(db.config, {
      registry: createToolRegistry([]),
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      priceFor: (_model, usage) =>
        Math.round(
          (usage.inputTokens * PRICES.inputPerMillion +
            usage.outputTokens * PRICES.outputPerMillion +
            (usage.cachedInputTokens ?? 0) * PRICES.cachedInputPerMillion) /
            1_000_000,
        ),
    })

    const record = await executor.start({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      startedBy: w.userId,
      definition,
      input: {},
    })
    return { runId: record.id, outcome: await executor.run(w.workspaceId, record.id) }
  }

  async function ledger(w: World) {
    return db.admin.query<{
      tokens_in: number
      tokens_cached_in: number
      tokens_out: number
      cost_cents: number
    }>(
      `SELECT tokens_in, tokens_cached_in, tokens_out, cost_cents
         FROM spend_ledger WHERE workspace_id = $1`,
      [w.workspaceId],
    )
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

  it('NFR-8 AC2: cached input tokens are recorded apart from fresh ones', async () => {
    // Given a call the provider served largely from its prompt cache
    const w = await world()
    models.script({
      chunks: ['Answered.'],
      usage: { inputTokens: 200, cachedInputTokens: 1_800, outputTokens: 50 },
    })

    // When it runs
    await run(w)

    // Then the ledger keeps them in separate columns. Folded together, the two
    // thousand input tokens would be indistinguishable from two thousand
    // uncached ones, and nothing later could separate them again.
    const [row] = await ledger(w)
    expect(row).toMatchObject({ tokens_in: 200, tokens_cached_in: 1_800, tokens_out: 50 })
  })

  it('NFR-8 AC2: a cached call is billed at the cached rate, not the fresh one', async () => {
    // Given two runs over the same volume of input, one cached and one not
    const cachedWorld = await world()
    models.script({
      chunks: ['Answered.'],
      usage: { inputTokens: 200, cachedInputTokens: 1_800, outputTokens: 50 },
    })
    await run(cachedWorld)

    const freshWorld = await world()
    models.script({
      chunks: ['Answered.'],
      usage: { inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 50 },
    })
    await run(freshWorld)

    // Then the cached one costs measurably less — and by the cached rate
    // exactly, not merely "less", because an assertion that only says less
    // passes for a fold that halves the price by accident.
    const [cached] = await ledger(cachedWorld)
    const [fresh] = await ledger(freshWorld)

    const expectedCached = Math.round(
      (200 * PRICES.inputPerMillion +
        50 * PRICES.outputPerMillion +
        1_800 * PRICES.cachedInputPerMillion) /
        1_000_000,
    )
    expect(cached!.cost_cents).toBe(expectedCached)
    expect(fresh!.cost_cents).toBeGreaterThan(cached!.cost_cents)
  })

  it('NFR-8 AC3: the stable prefix is sent ahead of the volatile body', async () => {
    // Given a team with a charter — the one input that applies to every turn,
    // and so the natural cacheable prefix
    const w = await world()
    await db.admin.execute(`UPDATE teams SET charter = $2 WHERE id = $1`, [
      w.teamId,
      'We ship small changes and we write the test first.',
    ])
    models.script({ chunks: ['Answered.'] })

    // When a turn runs
    await run(w)

    // Then the charter arrives as its own message, before the body. Caching is
    // a prefix match: concatenated in front of a body that changes every call,
    // it would produce a prefix that caches nothing and still costs a write.
    const [request] = models.requests()
    expect(request!.messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(request!.messages[0]!.content).toContain('we write the test first')
  })

  it("NFR-8 AC2: the run's cached cost reconciles exactly with its ledger rows", async () => {
    // Given a run
    const w = await world()
    models.script({
      chunks: ['Answered.'],
      usage: { inputTokens: 200, cachedInputTokens: 1_800, outputTokens: 50 },
    })
    const { runId } = await run(w)

    // When the run's cached total is compared against the rows that produced it
    const [run_] = await db.admin.query<{ cost_cents: number; tokens_in: number }>(
      `SELECT cost_cents, tokens_in FROM runs WHERE id = $1`,
      [runId],
    )
    const rows = await ledger(w)

    // Then they agree. A displayed cost that cannot be reconciled against the
    // calls that produced it is a number nobody can defend when it is queried.
    expect(run_!.cost_cents).toBe(rows.reduce((sum, r) => sum + r.cost_cents, 0))
  })
})
