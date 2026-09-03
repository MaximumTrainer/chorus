import { NotFoundError } from '@chorus/core'
import { withTenant, type DbConfig } from '@chorus/db'
import {
  emitHistoricalTrace,
  type HistoricalSpan,
  type SpanAttributes,
} from '@chorus/telemetry'

/**
 * Exporting a stored run as OpenTelemetry (AGENT-4 AC5).
 *
 * A run's trace already exists, in `run_events`, and this turns it into spans a
 * standard collector will accept. Two things it deliberately does *not* do:
 *
 * - It does not re-time anything. The spans carry the times the work actually
 *   happened, because a trace stamped with the moment somebody exported it
 *   collapses every historical run onto that moment.
 * - It does not flatten. Each event is a child of the run, in the run's trace,
 *   which is what makes the result readable as a run rather than as a log. A
 *   collector accepts a flat pile of spans just as readily as a tree, so the
 *   nesting has to be built or it is not there.
 */

interface RunRow {
  id: string
  workflow_name: string
  workflow_version: number
  status: string
  error: string | null
  cost_cents: number
  tokens_in: number
  tokens_out: number
  started_at: Date
  finished_at: Date | null
}

interface EventRow {
  seq: number
  kind: string
  payload: Record<string, unknown>
  at: Date
  prompt_id: string | null
  prompt_version: number | null
  prompt_hash: string | null
}

export interface ExportOptions {
  /**
   * An OTLP endpoint to send this export to.
   *
   * When given, the export gets its own exporter and is flushed before this
   * returns — a stored trace may well belong in a different backend from the
   * process's live telemetry, and it must not be swallowed by whatever that
   * process happens to be configured with. Absent, it goes wherever the
   * process's own tracing goes.
   */
  readonly endpoint?: string
}

/**
 * Attributes worth carrying, and only those.
 *
 * A payload spread wholesale onto a span would put prompt bodies into whatever
 * tracing backend a deployment runs, which is precisely the content the
 * redaction policy exists to keep out of places like that. So this is a
 * deliberate allow-list: the fields somebody would query a trace *by*.
 */
function attributesFor(event: EventRow): SpanAttributes {
  const payload = event.payload
  const attributes: Record<string, string | number | boolean> = {
    'chorus.event.kind': event.kind,
    'chorus.event.seq': event.seq,
  }

  const carry: ReadonlyArray<readonly [string, string]> = [
    ['step', 'chorus.step_id'],
    ['tool', 'chorus.tool'],
    ['model', 'chorus.model'],
    ['provider', 'chorus.provider'],
    ['workflow', 'chorus.workflow'],
    ['rule', 'chorus.routing.rule'],
    ['decision', 'chorus.routing.decision'],
    ['kind', 'chorus.checkpoint.kind'],
    ['mode', 'chorus.checkpoint.mode'],
    ['costCents', 'chorus.cost_cents'],
    ['tokensIn', 'chorus.tokens_in'],
    ['tokensOut', 'chorus.tokens_out'],
    ['latencyMs', 'chorus.latency_ms'],
  ]

  for (const [from, to] of carry) {
    const value = payload[from]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attributes[to] = value
    }
  }

  // Provenance, from the columns rather than the payload: this is what makes a
  // span in a backend traceable back to the exact template that produced it.
  if (event.prompt_id) attributes['chorus.prompt.id'] = event.prompt_id
  if (event.prompt_version !== null) attributes['chorus.prompt.version'] = event.prompt_version
  if (event.prompt_hash) attributes['chorus.prompt.hash'] = event.prompt_hash

  return attributes
}

/**
 * Emits one run's trace, returning how many spans went out.
 *
 * The count is returned rather than nothing, so a caller can assert a trace
 * exported completely instead of inferring it from an absence of errors.
 */
export async function exportRunTrace(
  config: DbConfig,
  workspaceId: string,
  runId: string,
  options: ExportOptions = {},
): Promise<number> {
  const { run, events } = await withTenant(
    workspaceId,
    async (tx) => {
      const [found] = await tx.query<RunRow>(
        `SELECT id, workflow_name, workflow_version, status, error, cost_cents,
                tokens_in, tokens_out, started_at, finished_at
           FROM runs WHERE id = $1`,
        [runId],
      )
      // Another workspace's run and one that never existed are alike from here.
      if (!found) throw new NotFoundError('No such run', { runId })

      const rows = await tx.query<EventRow>(
        `SELECT seq, kind, payload, at, prompt_id, prompt_version, prompt_hash
           FROM run_events WHERE run_id = $1 ORDER BY seq`,
        [runId],
      )
      return { run: found, events: rows }
    },
    { config },
  )

  const workflow = `${run.workflow_name}@${run.workflow_version}`
  // An unfinished run is still worth exporting — a run that crashed is the one
  // somebody most wants to look at — so its end is the last thing that happened.
  const finished =
    run.finished_at ?? events.at(-1)?.at ?? run.started_at

  const root: HistoricalSpan = {
    name: `agent.run ${workflow}`,
    startTime: run.started_at,
    endTime: finished,
    attributes: {
      'chorus.workspace_id': workspaceId,
      'chorus.run_id': run.id,
      'chorus.workflow': workflow,
      'chorus.run.status': run.status,
      'chorus.run.cost_cents': run.cost_cents,
      'chorus.run.tokens_in': run.tokens_in,
      'chorus.run.tokens_out': run.tokens_out,
      ...(run.error ? { 'chorus.run.error': run.error } : {}),
    },
    children: events.map((event) => ({
      name: `agent.${event.kind}`,
      // An event is a point in time, not an interval — `run_events` records
      // when a thing happened, not how long it took. Giving it a fabricated
      // duration would be inventing data; a zero-length span is honest and
      // renders correctly in every backend.
      startTime: event.at,
      endTime: event.at,
      attributes: attributesFor(event),
    })),
  }

  return emitHistoricalTrace(root, options.endpoint ? { endpoint: options.endpoint } : {})
}
