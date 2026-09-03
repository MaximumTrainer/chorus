import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid } from '@chorus/core'
import { createSpanCollector, initTelemetry, shutdownTelemetry } from '@chorus/telemetry'
import { exportRunTrace } from '../../src/trace-export.js'

/**
 * AGENT-4 AC5 — the exported trace is valid OpenTelemetry.
 *
 * > **Then** it is accepted by a standard collector with spans nested correctly
 * > and attributes preserved.
 *
 * Two claims, and they need different evidence.
 *
 * *Nested correctly, attributes preserved* is checked on the spans themselves,
 * because a collector's acknowledgement says nothing about parentage — it will
 * accept a flat pile of spans just as readily as a tree.
 *
 * *Accepted by a standard collector* can only be shown by sending it to one.
 * An assertion we write about wire format checks our reading of the
 * specification, not the specification; the collector's own
 * `otelcol_receiver_accepted_spans` counter is the collector's opinion, which
 * is the one the criterion asks for.
 */
describe('AGENT-4 AC5 OpenTelemetry export', () => {
  let db: IsolatedDatabase
  const spans = createSpanCollector()

  const collectorMetrics =
    process.env.CHORUS_OTLP_METRICS_URL ?? 'http://localhost:8888/metrics'
  const collectorEndpoint = process.env.CHORUS_OTEL_ENDPOINT ?? 'http://localhost:4318'

  /** The collector's own count of spans it has taken in. */
  async function acceptedSpans(): Promise<number> {
    const response = await fetch(collectorMetrics, { signal: AbortSignal.timeout(5_000) })
    const body = await response.text()
    let total = 0
    for (const line of body.split('\n')) {
      if (line.startsWith('otelcol_receiver_accepted_spans')) {
        const value = Number(line.trim().split(/\s+/).at(-1))
        if (Number.isFinite(value)) total += value
      }
    }
    return total
  }

  /** A run with one of each event kind, and known timings. */
  async function seedRun(): Promise<{ workspaceId: string; runId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    const [member] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1`,
      [workspaceId],
    )
    await db.admin.execute(`DELETE FROM run_events WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM run_steps WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM runs WHERE workspace_id = $1`, [workspaceId])

    const runId = ulid()
    await db.admin.execute(
      `INSERT INTO runs
         (id, workspace_id, workflow_name, workflow_version, started_by, status,
          cost_cents, tokens_in, tokens_out, started_at, finished_at)
       VALUES ($1, $2, 'traced-flow', 2, $3, 'succeeded', 41, 120, 45,
               now() - interval '10 seconds', now())`,
      [runId, workspaceId, member!.user_id],
    )

    const events: Array<[number, string, Record<string, unknown>]> = [
      [1, 'routing', { decision: 'rule', workflow: 'traced-flow', rule: 'agent-tagged-task' }],
      [2, 'tool_call', { step: 'prepare', tool: 'prepare' }],
      [3, 'model_call', { step: 'think', provider: 'fake', model: 'fake-1', costCents: 41 }],
      [4, 'checkpoint', { step: 'gate', kind: 'before_create_artefacts', mode: 'ask' }],
    ]
    for (const [seq, kind, payload] of events) {
      await db.admin.execute(
        `INSERT INTO run_events (id, workspace_id, run_id, seq, kind, payload, at)
         VALUES ($1, $2, $3, $4, $5, $6, now() - interval '5 seconds')`,
        [ulid(), workspaceId, runId, seq, kind, JSON.stringify(payload)],
      )
    }

    return { workspaceId, runId }
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    initTelemetry({ serviceName: 'chorus-test', exporter: spans.exporter })
  }, 120_000)

  afterAll(async () => {
    await shutdownTelemetry()
    await db?.drop()
  })

  it('AGENT-4 AC5: a run becomes one span tree, with every event beneath its run', async () => {
    spans.reset()
    const { workspaceId, runId } = await seedRun()

    const exported = await exportRunTrace(db.config, workspaceId, runId)
    expect(exported).toBe(5)

    const root = spans.root()
    expect(root, 'the run itself must be a span').toBeDefined()
    expect(root!.name).toBe('agent.run traced-flow@2')

    // Every other span is a child of the run. A flat pile of spans is accepted
    // by any collector and answers nothing — the nesting is what makes a trace
    // readable as a run rather than as a log.
    const children = spans.childrenOf(root!)
    expect(children).toHaveLength(4)
    expect(children).toHaveLength(spans.collected().length - 1)
    for (const child of children) {
      // And in the same trace, which is the other half of "nested correctly".
      expect(child.traceId, `${child.name} is in a different trace`).toBe(root!.traceId)
    }
  })

  it('AGENT-4 AC5: attributes survive the round trip, including the ones worth querying', async () => {
    spans.reset()
    const { workspaceId, runId } = await seedRun()
    await exportRunTrace(db.config, workspaceId, runId)

    const collected = spans.collected()
    const root = spans.root()!

    // Tenancy and identity, so a span found in a backend can be traced back to
    // the run and the workspace it belongs to.
    expect(root.attributes).toMatchObject({
      'chorus.workspace_id': workspaceId,
      'chorus.run_id': runId,
      'chorus.workflow': 'traced-flow@2',
      'chorus.run.status': 'succeeded',
      'chorus.run.cost_cents': 41,
    })

    const model = collected.find((span) => span.name.includes('model_call'))
    expect(model, 'the model call must be its own span').toBeDefined()
    expect(model!.attributes).toMatchObject({
      'chorus.step_id': 'think',
      'chorus.model': 'fake-1',
      'chorus.provider': 'fake',
    })
  })

  it('AGENT-4 AC5: spans carry the times they actually happened, not the time they were exported', async () => {
    spans.reset()
    const { workspaceId, runId } = await seedRun()
    const exportedAt = Date.now()
    await exportRunTrace(db.config, workspaceId, runId)

    const startedMs = spans.root()!.startedAtMs

    // The run started ten seconds before it was exported. A trace stamped with
    // the export time collapses every historical run onto the moment somebody
    // looked at it, which makes the whole export useless for anything but
    // counting.
    expect(exportedAt - startedMs).toBeGreaterThan(5_000)
  })

  it('AGENT-4 AC5: a standard collector accepts what we send it', async () => {
    // The claim the criterion actually makes, and the only way to support it.
    // If the collector is not running this fails rather than skipping: a gate
    // that quietly disappears when its dependency is absent is not a gate.
    const before = await acceptedSpans()

    const { workspaceId, runId } = await seedRun()
    await exportRunTrace(db.config, workspaceId, runId, {
      endpoint: collectorEndpoint,
    })

    // The collector batches; poll rather than sleep (CLAUDE.md §5).
    const deadline = Date.now() + 20_000
    let after = before
    while (after <= before && Date.now() < deadline) {
      after = await acceptedSpans()
    }

    expect(after, 'the collector accepted no spans').toBeGreaterThan(before)
  })
})
