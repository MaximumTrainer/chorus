import { NotFoundError, ValidationError } from '@chorus/core'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'
import type { TaskService } from './tasks.js'
import { taskContentHash, type TrackerSink } from './task-push.js'

/**
 * Keeping a pushed task in step with its tracker issue (TASK-4).
 *
 * The honest part of the requirement, and the one that distinguishes this from
 * an integration that quietly destroys edits: when an inbound change arrives
 * and the task has *also* changed locally since the last sync, neither side is
 * overwritten and the link enters `conflict` (AC3). Only when the local side is
 * untouched does the inbound status mirror onto the task, attributed to the
 * integration (AC2).
 *
 * "Changed since the last sync" is a content hash, not a timestamp — a
 * timestamp produces false conflicts under clock skew and misses them under
 * fast edits (`last_synced_hash`, written by the push and refreshed by each
 * clean mirror).
 */

/** A per-tracker status map, as stored on the integration: Chorus status → external status. */
export type StatusMap = Readonly<Record<string, string>>

export interface MirrorInboundInput {
  readonly workspaceId: string
  readonly integrationId: string
  readonly externalId: string
  /** The external issue's new status name, as the tracker names it. */
  readonly externalStatus: string
}

export type MirrorResult =
  | { readonly result: 'mirrored'; readonly status: string }
  /** Both sides changed since the last sync; the link is now `conflict` (AC3). */
  | { readonly result: 'conflict' }
  /** The external status has no entry in the map, so it is left for a human (not guessed). */
  | { readonly result: 'unmapped' }
  /** No task is linked to this external issue, so there is nothing to mirror. */
  | { readonly result: 'unlinked' }

export interface TaskSyncService {
  mirrorInbound(input: MirrorInboundInput): Promise<MirrorResult>
  /**
   * Pushes the task's current status out to its tracker issue (TASK-4 AC5).
   *
   * Refuses, by name, when the task's status has no entry in the map — pushing
   * a status the tracker has no target for would mean guessing a state in
   * someone else's system, which is the silent wrong the requirement forbids.
   */
  transitionOut(input: {
    readonly workspaceId: string
    readonly taskId: string
    readonly actorId: string
  }): Promise<{ readonly toExternalStatus: string }>
}

/** The Chorus status an external status maps to, or undefined when the map has no entry. */
export function chorusStatusFor(map: StatusMap, externalStatus: string): string | undefined {
  // The map is stored Chorus → external; the inbound direction is the inverse.
  // Compared case-insensitively on the external side, because a tracker's
  // status names are display text an admin transcribed, not identifiers.
  const wanted = externalStatus.trim().toLowerCase()
  for (const [chorus, external] of Object.entries(map)) {
    if (external.trim().toLowerCase() === wanted) return chorus
  }
  return undefined
}

/** The external status a Chorus status maps to, or a refusal naming the gap (AC5). */
export function externalStatusFor(map: StatusMap, chorusStatus: string): string {
  const external = map[chorusStatus]
  if (!external) {
    throw new ValidationError(
      `No tracker status is mapped for the "${chorusStatus}" status; configure the status map first`,
      { field: 'statusMap', status: chorusStatus },
    )
  }
  return external
}

export function createTaskSyncService(
  config: DbConfig,
  deps: { readonly tasks: TaskService; readonly sink: TrackerSink },
): TaskSyncService {
  async function statusMap(t: TenantTx, integrationId: string): Promise<StatusMap> {
    const [row] = await t.query<{ config: { statusMap?: Record<string, string> } }>(
      `SELECT config FROM integrations WHERE id = $1`,
      [integrationId],
    )
    return row?.config?.statusMap ?? {}
  }

  return {
    async mirrorInbound({ workspaceId, integrationId, externalId, externalStatus }) {
      // Resolve the link, the map and the mapped status first, so a change for
      // an unlinked issue or an unmapped status does nothing — read-only — and
      // the task is touched only when there is a clean change to apply.
      const resolved = await withTenant(
        workspaceId,
        async (t) => {
          const [link] = await t.query<{
            task_id: string
            last_synced_hash: string | null
          }>(
            `SELECT task_id, last_synced_hash FROM task_tracker_links
              WHERE integration_id = $1 AND external_id = $2`,
            [integrationId, externalId],
          )
          if (!link) return undefined
          const mapped = chorusStatusFor(await statusMap(t, integrationId), externalStatus)
          return { link, mapped }
        },
        { config },
      )

      if (!resolved) return { result: 'unlinked' }
      if (!resolved.mapped) return { result: 'unmapped' }

      const task = await deps.tasks.get(workspaceId, resolved.link.task_id)

      // Both sides changed since the last sync: the local content no longer
      // matches the hash taken at the last clean sync, and a remote change has
      // arrived now. Neither wins — the link is marked `conflict` and the task
      // is left exactly as it is (AC3).
      const localChanged =
        resolved.link.last_synced_hash !== null &&
        taskContentHash(task) !== resolved.link.last_synced_hash
      if (localChanged) {
        await withTenant(
          workspaceId,
          (t) =>
            t.execute(
              `UPDATE task_tracker_links SET sync_state = 'conflict', updated_at = now()
                WHERE integration_id = $1 AND external_id = $2`,
              [integrationId, externalId],
            ),
          { config },
        )
        return { result: 'conflict' }
      }

      if (task.status === resolved.mapped) {
        // Already there — refresh nothing-changing is not worth an audit row.
        return { result: 'mirrored', status: task.status }
      }

      // The clean case: mirror the status, attributed to the integration, and
      // move `last_synced_hash` to the state we just agreed on, so the next
      // local edit is measured from here (AC2).
      const nextHash = taskContentHash({ ...task, status: resolved.mapped })
      await withTenant(
        workspaceId,
        (t) =>
          mutate(t, {
            workspaceId,
            actor: { type: 'integration', id: integrationId },
            action: 'task.sync_status',
            targetType: 'task',
            targetId: resolved.link.task_id,
            before: { status: task.status },
            after: { status: resolved.mapped },
            apply: async () => {
              await t.execute(
                `UPDATE tasks SET status = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
                [workspaceId, resolved.link.task_id, resolved.mapped],
              )
              await t.execute(
                `UPDATE task_tracker_links
                    SET last_synced_hash = $3, sync_state = 'synced', updated_at = now()
                  WHERE integration_id = $1 AND external_id = $2`,
                [integrationId, externalId, nextHash],
              )
            },
          }),
        { config },
      )
      return { result: 'mirrored', status: resolved.mapped }
    },

    async transitionOut({ workspaceId, taskId, actorId }) {
      const task = await deps.tasks.get(workspaceId, taskId)

      const { map, externalId, integrationId, teamId } = await withTenant(
        workspaceId,
        async (t) => {
          // The task's tracker link — resolved from the task, so a transition
          // writes to the issue it is already mapped to rather than one named
          // in the request.
          const [link] = await t.query<{ integration_id: string; external_id: string }>(
            `SELECT integration_id, external_id FROM task_tracker_links WHERE task_id = $1 LIMIT 1`,
            [taskId],
          )
          if (!link) {
            throw new NotFoundError('This task is not linked to a tracker; push it first', {
              taskId,
            })
          }
          return {
            map: await statusMap(t, link.integration_id),
            externalId: link.external_id,
            integrationId: link.integration_id,
            teamId: task.teamId,
          }
        },
        { config },
      )

      // Refuses here, before any external write, when the status is unmapped (AC5).
      const toExternalStatus = externalStatusFor(map, task.status)

      await deps.sink.transition({
        workspaceId,
        teamId,
        integrationId,
        externalId,
        toExternalStatus,
        idempotencyKey: `task-transition:${taskId}:${task.status}`,
      })

      // The task and the tracker now agree on the status, so move the synced
      // hash to this state — a later inbound change is measured from here.
      const nextHash = taskContentHash(task)
      await withTenant(
        workspaceId,
        (t) =>
          mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            action: 'task.transition',
            targetType: 'task',
            targetId: taskId,
            after: { toExternalStatus },
            apply: () =>
              t.execute(
                `UPDATE task_tracker_links
                    SET last_synced_hash = $3, sync_state = 'synced', updated_at = now()
                  WHERE integration_id = $1 AND external_id = $2`,
                [integrationId, externalId, nextHash],
              ),
          }),
        { config, userId: actorId },
      )
      return { toExternalStatus }
    },
  }
}
