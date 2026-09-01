import { ulid } from '@chorus/core'
import type { TenantTx } from './client.js'

/**
 * Audited mutation (NFR-5 AC1, CLAUDE.md §6.3).
 *
 * The audit row is written inside the *same transaction* as the change. An
 * audit written afterwards is missing exactly when something went wrong — the
 * failure that rolled the change back also skipped the record of it. Here the
 * two are atomic in both directions: no change without a record, and no record
 * without a change.
 *
 * Written by this wrapper rather than by a database trigger, because a trigger
 * knows what changed but not *who* intended it or *why* (architecture.md §8.4).
 */

export type ActorType = 'user' | 'run' | 'integration' | 'system'

export interface Actor {
  readonly type: ActorType
  /** Absent only for `system`, which has no identity to attribute to. */
  readonly id?: string
}

export interface MutationSpec<T> {
  readonly workspaceId: string
  readonly actor: Actor
  /** Dotted verb, e.g. `team.create`. Used for audit filtering (WS-6 AC3). */
  readonly action: string
  readonly targetType: string
  readonly targetId?: string
  /** State before the change, for updates and deletes. */
  readonly before?: unknown
  /** State after the change, for creates and updates. */
  readonly after?: unknown
  /** The change itself. Runs before the audit row is written. */
  apply(): Promise<T>
}

export async function mutate<T>(tx: TenantTx, spec: MutationSpec<T>): Promise<T> {
  const result = await spec.apply()

  await tx.execute(
    `INSERT INTO audit_events
       (id, workspace_id, actor_type, actor_id, action, target_type, target_id, before, after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      ulid(),
      spec.workspaceId,
      spec.actor.type,
      spec.actor.id ?? null,
      spec.action,
      spec.targetType,
      spec.targetId ?? null,
      spec.before === undefined ? null : JSON.stringify(spec.before),
      spec.after === undefined ? null : JSON.stringify(spec.after),
    ],
  )

  return result
}
