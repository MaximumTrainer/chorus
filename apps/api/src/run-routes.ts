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
