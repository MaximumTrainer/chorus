import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createRetentionPurge } from '../../src/retention-purge.js'

/**
 * NFR-4 AC3 — the retention purge, against a real database.
 *
 * Rows are written directly with known timestamps so each case can say exactly
 * which side of a cutoff they are on. The purge is told the time; it never
 * reads the clock.
 */
describe('NFR-4 retention purge', () => {
  let db: IsolatedDatabase

  const NOW = new Date('2026-11-19T12:00:00Z')
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  /** A workspace with one run, and a model call made `age` days ago carrying bodies. */
  async function aWorkspace(periods: Partial<Record<'prompts' | 'run_traces', number>>, ages: number[]) {
    const workspaceId = ulid()
    const userId = ulid()
    await db.admin.execute(`INSERT INTO users (id, email, name) VALUES ($1, $2, 'Owner')`, [
      userId,
      `${userId}@example.test`,
    ])
    await db.admin.execute(`INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Kept', $1)`, [workspaceId])
    const runId = ulid()
    await db.admin.execute(
      `INSERT INTO runs (id, workspace_id, workflow_name, workflow_version, started_by, tokens_out)
       VALUES ($1, $2, 'flow', 1, $3, 20)`,
      [runId, workspaceId, userId],
    )
    await db.admin.execute(
      `INSERT INTO spend_ledger (id, workspace_id, run_id, provider, model, purpose, tokens_in, tokens_out, cost_cents)
       VALUES ($1, $2, $3, 'fake', 'fake-1', 'run', 10, 20, 1)`,
      [ulid(), workspaceId, runId],
    )
    let seq = 0
    for (const age of ages) {
      seq += 1
      await db.admin.execute(
        `INSERT INTO run_events (id, workspace_id, run_id, seq, kind, payload, at)
         VALUES ($1, $2, $3, $4, 'model_call', $5, $6)`,
        [
          ulid(),
          workspaceId,
          runId,
          seq,
          JSON.stringify({
            model: 'fake-1',
            tokensOut: 20,
            prompt: `prompt sent ${age} days ago`,
            promptHash: 'a'.repeat(64),
            response: `response from ${age} days ago`,
            responseHash: 'b'.repeat(64),
          }),
          daysAgo(age),
        ],
      )
    }
    for (const [dataClass, days] of Object.entries(periods)) {
      await db.admin.execute(
        `INSERT INTO retention_policies (workspace_id, data_class, days, updated_by) VALUES ($1, $2, $3, $4)`,
        [workspaceId, dataClass, days, userId],
      )
    }
    return { workspaceId, runId }
  }

  const events = (runId: string) =>
    db.admin.query<{ seq: number; payload: Record<string, unknown> }>(
      `SELECT seq, payload FROM run_events WHERE run_id = $1 ORDER BY seq`,
      [runId],
    )

  const purges = (workspaceId: string) =>
    db.admin.query<{ actor_type: string; after: Record<string, unknown> }>(
      `SELECT actor_type, after FROM audit_events WHERE workspace_id = $1 AND action = 'retention.purge'`,
      [workspaceId],
    )

  it('NFR-4 AC3: removes prompt bodies older than the period and leaves newer ones', async () => {
    const { runId } = await aWorkspace({ prompts: 7 }, [10, 3])

    await createRetentionPurge({ dbConfig: db.config }).run(NOW)

    const [old, recent] = await events(runId)
    expect(old!.payload.prompt).toBeUndefined()
    expect(old!.payload.response).toBeUndefined()
    // The structural record, hashes included, is what a purge keeps.
    expect(old!.payload).toMatchObject({ model: 'fake-1', tokensOut: 20, promptHash: 'a'.repeat(64) })
    expect(recent!.payload.prompt).toBe('prompt sent 3 days ago')
  })

  it('NFR-4 AC3: deletes trace events older than the period, keeping the run and its spend', async () => {
    const { runId } = await aWorkspace({ run_traces: 30 }, [40, 5])

    await createRetentionPurge({ dbConfig: db.config }).run(NOW)

    expect((await events(runId)).map((event) => event.seq)).toEqual([2])
    const [run] = await db.admin.query(`SELECT tokens_out FROM runs WHERE id = $1`, [runId])
    expect(run).toMatchObject({ tokens_out: 20 })
    const spend = await db.admin.query(`SELECT 1 FROM spend_ledger WHERE run_id = $1`, [runId])
    expect(spend).toHaveLength(1)
  })

  it('NFR-4 AC3: a workspace with no period keeps everything', async () => {
    const kept = await aWorkspace({}, [400])
    await aWorkspace({ prompts: 1, run_traces: 1 }, [400])

    await createRetentionPurge({ dbConfig: db.config }).run(NOW)

    const [event] = await events(kept.runId)
    expect(event!.payload.prompt).toBe('prompt sent 400 days ago')
    expect(await purges(kept.workspaceId)).toHaveLength(0)
  })

  it('NFR-4 AC3: audits each purge with its class, period, cutoff and count', async () => {
    const { workspaceId } = await aWorkspace({ prompts: 7 }, [10, 9, 1])

    await createRetentionPurge({ dbConfig: db.config }).run(NOW)

    expect(await purges(workspaceId)).toEqual([
      {
        actor_type: 'system',
        after: { dataClass: 'prompts', days: 7, cutoff: daysAgo(7).toISOString(), purged: 2 },
      },
    ])
  })

  it('NFR-4 AC3: running again purges nothing more and records nothing more (idempotent)', async () => {
    const { workspaceId, runId } = await aWorkspace({ prompts: 7, run_traces: 30 }, [40, 10])
    const purge = createRetentionPurge({ dbConfig: db.config })

    await purge.run(NOW)
    const afterFirst = await events(runId)
    await purge.run(NOW)

    expect(await events(runId)).toEqual(afterFirst)
    expect((await purges(workspaceId)).map((row) => row.after.dataClass).sort()).toEqual([
      'prompts',
      'run_traces',
    ])
  })
})
