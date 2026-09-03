import type { CheckpointKind, CheckpointMode, PolicySource } from '@chorus/core'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Settling a checkpoint (AGENT-3, architecture.md §11.5).
 *
 * The rule this file exists to make structural is AC4: **the first decision
 * wins**. The same gate is presented in the web UI, in an email and in a chat
 * message at once, and every one of those buttons stays clickable after
 * someone else has answered. A read-then-write would let two of them both
 * succeed, and the second would silently overwrite the first — an approval
 * quietly becoming a rejection, or the reverse.
 *
 * So the decision is a single conditional `UPDATE ... WHERE status = 'pending'`.
 * Postgres decides who was first; nothing here does. A caller that loses gets
 * the settled row back rather than an error, because the person who pressed the
 * stale button needs to see what actually happened.
 */

export const CHECKPOINT_DECISIONS = ['approve', 'approve_with_edits', 'reject'] as const
export type CheckpointDecision = (typeof CHECKPOINT_DECISIONS)[number]

export type CheckpointStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface CheckpointRecord {
  readonly id: string
  readonly runId: string
  readonly stepId: string
  readonly kind: CheckpointKind
  readonly mode: CheckpointMode
  readonly source: PolicySource
  readonly status: CheckpointStatus
  readonly payload: Record<string, unknown>
  readonly editedPayload: Record<string, unknown> | null
  readonly expiresAt: string
  readonly decidedBy: string | null
  readonly decision: CheckpointDecision | null
  readonly decisionNote: string | null
  readonly decidedAt: string | null
}

export interface DecisionInput {
  readonly workspaceId: string
  readonly checkpointId: string
  readonly decidedBy: string
  readonly decision: CheckpointDecision
  /** Only meaningful for `approve_with_edits`; ignored otherwise. */
  readonly editedPayload?: Record<string, unknown>
  readonly note?: string
}

/**
 * Three outcomes, tagged.
 *
 * `already_settled` is deliberately not an error: it is the ordinary result of
 * two surfaces showing one gate, and it carries the settled row so the losing
 * surface can display the truth instead of a failure.
 */
export type DecisionOutcome =
  | { readonly kind: 'settled'; readonly checkpoint: CheckpointRecord }
  | { readonly kind: 'already_settled'; readonly checkpoint: CheckpointRecord }
  | { readonly kind: 'not_found' }

export interface CheckpointRow {
  id: string
  run_id: string
  step_id: string
  kind: CheckpointKind
  policy_source: PolicySource
  mode: CheckpointMode
  status: CheckpointStatus
  payload: Record<string, unknown>
  edited_payload: Record<string, unknown> | null
  expires_at: Date
  decided_by: string | null
  decision: CheckpointDecision | null
  decision_note: string | null
  decided_at: Date | null
}

export const CHECKPOINT_COLUMNS = `id, run_id, step_id, kind, policy_source, mode, status,
                                   payload, edited_payload, expires_at, decided_by, decision,
                                   decision_note, decided_at`

export function toCheckpointRecord(row: CheckpointRow): CheckpointRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    kind: row.kind,
    mode: row.mode,
    source: row.policy_source,
    status: row.status,
    payload: row.payload,
    editedPayload: row.edited_payload,
    expiresAt: row.expires_at.toISOString(),
    decidedBy: row.decided_by,
    decision: row.decision,
    decisionNote: row.decision_note,
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
  }
}

export async function readCheckpoint(
  config: DbConfig,
  workspaceId: string,
  checkpointId: string,
): Promise<CheckpointRecord | undefined> {
  const [row] = await withTenant(
    workspaceId,
    (tx) =>
      tx.query<CheckpointRow>(
        `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE id = $1`,
        [checkpointId],
      ),
    { config },
  )
  return row ? toCheckpointRecord(row) : undefined
}

/** Every checkpoint a run has reached, oldest first. */
export async function checkpointsForRun(
  tx: TenantTx,
  runId: string,
): Promise<CheckpointRecord[]> {
  const rows = await tx.query<CheckpointRow>(
    `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE run_id = $1 ORDER BY created_at`,
    [runId],
  )
  return rows.map(toCheckpointRecord)
}

/**
 * Raised only to roll the transaction back.
 *
 * The audit row is written inside the same transaction as the decision, which
 * is what makes "no change without a record" true. But the conditional update
 * may match nothing, and an audit row for a decision that did not take effect
 * is worse than none — it would show two people approving the same gate. So
 * the loser throws, the transaction rolls back both statements together, and
 * the settled truth is re-read outside it.
 */
class NotThePendingOne extends Error {}

export async function decideCheckpoint(
  config: DbConfig,
  input: DecisionInput,
): Promise<DecisionOutcome> {
  const { workspaceId, checkpointId, decidedBy, decision } = input
  const status: CheckpointStatus = decision === 'reject' ? 'rejected' : 'approved'
  // Edits belong to the decision that made them — the table says so too, so
  // refusing here as well turns a constraint violation into a clear result.
  const edited = decision === 'approve_with_edits' ? (input.editedPayload ?? {}) : null

  const settled = await withTenant(
    workspaceId,
    async (tx) => {
      const [before] = await tx.query<{ status: CheckpointStatus }>(
        `SELECT status FROM checkpoints WHERE id = $1`,
        [checkpointId],
      )
      if (!before) return undefined

      const rows = await mutate(tx, {
        workspaceId,
        actor: { type: 'user', id: decidedBy },
        action: `checkpoint.${decision}`,
        targetType: 'checkpoint',
        targetId: checkpointId,
        before: { status: before.status },
        after: { status, decision },
        apply: () =>
          tx.query<CheckpointRow>(
            `UPDATE checkpoints
                SET status = $2, decision = $3, decided_by = $4, decided_at = now(),
                    decision_note = $5, edited_payload = $6
              WHERE id = $1 AND status = 'pending'
              RETURNING ${CHECKPOINT_COLUMNS}`,
            [
              checkpointId,
              status,
              decision,
              decidedBy,
              input.note ?? null,
              edited === null ? null : JSON.stringify(edited),
            ],
          ),
      })

      const [row] = rows
      if (!row) throw new NotThePendingOne()
      return toCheckpointRecord(row)
    },
    { config },
  ).catch((error: unknown) => {
    if (error instanceof NotThePendingOne) return null
    throw error
  })

  if (settled === undefined) return { kind: 'not_found' }
  if (settled !== null) return { kind: 'settled', checkpoint: settled }

  const current = await readCheckpoint(config, workspaceId, checkpointId)
  return current ? { kind: 'already_settled', checkpoint: current } : { kind: 'not_found' }
}

export function isCheckpointDecision(value: unknown): value is CheckpointDecision {
  return typeof value === 'string' && (CHECKPOINT_DECISIONS as readonly string[]).includes(value)
}
