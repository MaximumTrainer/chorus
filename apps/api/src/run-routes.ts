import { ConflictError, NotFoundError, ValidationError } from '@chorus/core'
import {
  CHECKPOINT_COLUMNS,
  decideCheckpoint,
  isCheckpointDecision,
  toCheckpointRecord,
  type CheckpointRecord,
  type CheckpointRow,
} from '@chorus/agent'
import { withTenant, type DbConfig } from '@chorus/db'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'

/**
 * Runs and their checkpoints (AGENT-3).
 *
 * The API's job here is narrow and worth stating: it **settles a decision**. It
 * does not execute runs — resumption is a queued job, and a route that ran a
 * workflow inline would tie a person's browser to however long the rest of the
 * workflow takes. So `resumeRun` is injected, and in a deployment it enqueues.
 *
 * Deciding is a `member` action. The gate stands in front of something the
 * member's own run proposed, and requiring a more senior role to approve it
 * would make working through an agent harder than doing the same thing by hand
 * — which is how a gate ends up being routed around rather than answered.
 */

export interface RunResumer {
  (workspaceId: string, runId: string): Promise<void>
}

interface RunRow {
  id: string
  workflow_name: string
  workflow_version: number
  status: string
  error: string | null
  started_by: string
  started_at: Date
  finished_at: Date | null
}

export interface RunView {
  readonly id: string
  readonly workflowName: string
  readonly workflowVersion: number
  readonly status: string
  readonly error: string | null
  readonly startedBy: string
  readonly startedAt: string
  readonly finishedAt: string | null
  /** The gate it is waiting on, when it is waiting on one. */
  readonly checkpoint?: CheckpointRecord
  /** Every gate this run has reached, settled or not. */
  readonly checkpoints: readonly CheckpointRecord[]
}

export function runRoutes(config: DbConfig, resumeRun?: RunResumer): RouteDefinition[] {
  const readRun = async (workspaceId: string, runId: string): Promise<RunView> =>
    withTenant(
      workspaceId,
      async (tx) => {
        const [run] = await tx.query<RunRow>(
          `SELECT id, workflow_name, workflow_version, status, error, started_by,
                  started_at, finished_at
             FROM runs WHERE id = $1`,
          [runId],
        )
        // A run in another workspace and one that never existed are alike from
        // here: row-level security did not surface it, and saying which is
        // which would leak existence (WS-2 AC4).
        if (!run) throw new NotFoundError('No such run', { runId })

        const checkpoints = (
          await tx.query<CheckpointRow>(
            `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE run_id = $1 ORDER BY created_at`,
            [runId],
          )
        ).map(toCheckpointRecord)

        const pending = checkpoints.find((c) => c.status === 'pending')

        return {
          id: run.id,
          workflowName: run.workflow_name,
          workflowVersion: run.workflow_version,
          status: run.status,
          error: run.error,
          startedBy: run.started_by,
          startedAt: run.started_at.toISOString(),
          finishedAt: run.finished_at ? run.finished_at.toISOString() : null,
          ...(pending ? { checkpoint: pending } : {}),
          checkpoints,
        }
      },
      { config },
    )

  /**
   * The trace (AGENT-4).
   *
   * Three things together, because they are only useful together: what the run
   * did, what it spent, and what it says about itself. A cost shown without the
   * calls behind it is a number nobody can defend when it is questioned, so the
   * ledger rows travel with the total they sum to.
   */
  const readTrace = async (workspaceId: string, runId: string) =>
    withTenant(
      workspaceId,
      async (tx) => {
        const [run] = await tx.query<
          RunRow & { cost_cents: number; tokens_in: number; tokens_out: number }
        >(
          `SELECT id, workflow_name, workflow_version, status, error, started_by,
                  started_at, finished_at, cost_cents, tokens_in, tokens_out
             FROM runs WHERE id = $1`,
          [runId],
        )
        if (!run) throw new NotFoundError('No such run', { runId })

        const events = await tx.query<{
          seq: number
          kind: string
          payload: Record<string, unknown>
          at: Date
          prompt_id: string | null
          prompt_version: number | null
          prompt_hash: string | null
        }>(
          `SELECT seq, kind, payload, at, prompt_id, prompt_version, prompt_hash
             FROM run_events WHERE run_id = $1 ORDER BY seq`,
          [runId],
        )

        const spend = await tx.query<{
          provider: string
          model: string
          purpose: string
          tokens_in: number
          tokens_out: number
          cost_cents: number
          latency_ms: number | null
          at: Date
        }>(
          `SELECT provider, model, purpose, tokens_in, tokens_out, cost_cents, latency_ms, at
             FROM spend_ledger WHERE run_id = $1 ORDER BY at`,
          [runId],
        )

        return {
          run: {
            id: run.id,
            workflow: `${run.workflow_name}@${run.workflow_version}`,
            status: run.status,
            error: run.error,
            startedBy: run.started_by,
            startedAt: run.started_at.toISOString(),
            finishedAt: run.finished_at ? run.finished_at.toISOString() : null,
            costCents: run.cost_cents,
            tokensIn: run.tokens_in,
            tokensOut: run.tokens_out,
          },
          events: events.map((event) => ({
            seq: event.seq,
            kind: event.kind,
            at: event.at.toISOString(),
            payload: event.payload,
            ...(event.prompt_id
              ? {
                  prompt: {
                    id: event.prompt_id,
                    version: event.prompt_version,
                    hash: event.prompt_hash,
                  },
                }
              : {}),
          })),
          spend: spend.map((row) => ({
            provider: row.provider,
            model: row.model,
            purpose: row.purpose,
            tokensIn: row.tokens_in,
            tokensOut: row.tokens_out,
            costCents: row.cost_cents,
            latencyMs: row.latency_ms,
            at: row.at.toISOString(),
          })),
        }
      },
      { config },
    )

  const readCheckpointIn = async (
    workspaceId: string,
    checkpointId: string,
  ): Promise<CheckpointRecord> => {
    const [row] = await withTenant(
      workspaceId,
      (tx) =>
        tx.query<CheckpointRow>(
          `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE id = $1`,
          [checkpointId],
        ),
      { config },
    )
    if (!row) throw new NotFoundError('No such checkpoint', { checkpointId })
    return toCheckpointRecord(row)
  }

  return [
    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/runs/:runId',
      summary: 'Read a run, its status and the checkpoint it is waiting on.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(await readRun(c.req.param('workspaceId'), c.req.param('runId'))),
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/runs/:runId/trace',
      summary: 'Read a run’s full trace: its events, its spend and its totals.',
      // A trace carries prompts, tool inputs and costs. It is a member-level
      // read because it is the record of work a member did, and it is scoped
      // by the workspace the route names — a run in another one is not found.
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(await readTrace(c.req.param('workspaceId'), c.req.param('runId'))),
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/checkpoints/:checkpointId',
      summary: 'Read a checkpoint, the action it gates and how it was settled.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(await readCheckpointIn(c.req.param('workspaceId'), c.req.param('checkpointId'))),
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/checkpoints/:checkpointId/decision',
      summary: 'Approve, approve with edits, or reject a checkpoint, and resume the run.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        const checkpointId = c.req.param('checkpointId')
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>

        if (!isCheckpointDecision(body.decision)) {
          throw new ValidationError(
            'decision must be one of approve, approve_with_edits, reject',
            { field: 'decision' },
          )
        }
        if (
          body.decision === 'approve_with_edits' &&
          (typeof body.editedPayload !== 'object' || body.editedPayload === null)
        ) {
          // Approving with edits and supplying none would silently approve the
          // original, which is the opposite of what the person meant.
          throw new ValidationError('editedPayload is required to approve with edits', {
            field: 'editedPayload',
          })
        }

        const outcome = await decideCheckpoint(config, {
          workspaceId,
          checkpointId,
          decidedBy: caller(c).userId,
          decision: body.decision,
          ...(typeof body.note === 'string' ? { note: body.note } : {}),
          ...(body.decision === 'approve_with_edits'
            ? { editedPayload: body.editedPayload as Record<string, unknown> }
            : {}),
        })

        if (outcome.kind === 'not_found') {
          throw new NotFoundError('No such checkpoint', { checkpointId })
        }

        if (outcome.kind === 'already_settled') {
          // AC4. The stale button on another surface. It carries the settled
          // record, because the person pressing it needs to see what actually
          // happened rather than an error telling them nothing.
          throw new ConflictError('This checkpoint has already been decided', {
            settled: outcome.checkpoint,
          })
        }

        // The run continues (or ends) as a consequence of the decision, never
        // inside this request in a deployment.
        if (resumeRun) await resumeRun(workspaceId, outcome.checkpoint.runId)

        return c.json(await readCheckpointIn(workspaceId, checkpointId))
      },
    }),
  ]
}
