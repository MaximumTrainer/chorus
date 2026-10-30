import { createHash } from 'node:crypto'
import { NotFoundError, ValidationError, ulid, type ExternalRef } from '@chorus/core'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'
import type { TaskService } from './tasks.js'

/**
 * Pushing a task to its tracker (TASK-4).
 *
 * Chorus does not replace the tracker, so a pushed task is two objects kept in
 * step: the Chorus task and the external issue. This creates or updates the
 * issue and records the mapping — external id, key and url — so the link has a
 * round-trip identity (AC1).
 *
 * The push is idempotent (AC4) at two levels. The mapping is unique per
 * (task, integration): a second push updates the issue it already made rather
 * than opening another. And the external write itself carries a key stable per
 * task, so even a create whose response was lost resolves, on the connector's
 * search-before-create, to the one issue — the mapping is the fast path, the
 * key is the safety net.
 *
 * The external write goes through a `TrackerSink` port rather than a connector
 * directly: a fake records it in a test, and the production binding performs it
 * through the connector sink and its `before_external_write` gate (INT-4), so
 * an agent-initiated push is gated while a user's push from the UI is their own
 * explicit action (AC6).
 */

/** The external write a push makes, as a port so tests fake it and prod binds a connector. */
export interface TrackerSink {
  createIssue(input: {
    readonly workspaceId: string
    readonly teamId: string
    readonly integrationId: string
    readonly title: string
    readonly description: string
    /** Stable per task, so a lost-response retry resolves rather than duplicates. */
    readonly idempotencyKey: string
  }): Promise<ExternalRef>
  updateIssue(input: {
    readonly workspaceId: string
    readonly teamId: string
    readonly integrationId: string
    readonly externalId: string
    readonly title: string
    readonly description: string
    readonly idempotencyKey: string
  }): Promise<ExternalRef>
}

export interface TaskTrackerLink {
  readonly taskId: string
  readonly integrationId: string
  readonly externalId: string
  readonly externalKey: string | null
  readonly externalUrl: string | null
  readonly syncState: 'synced' | 'pending' | 'conflict'
}

export interface TaskPushService {
  push(input: {
    readonly workspaceId: string
    readonly taskId: string
    readonly actorId: string
  }): Promise<TaskTrackerLink>
}

/** The trackers a kind-agnostic push resolves, in order. */
const TRACKER_KINDS = ['linear', 'jira', 'clickup']

/**
 * The task's content hash, for conflict detection (AC3).
 *
 * A hash and not a timestamp: a timestamp produces false conflicts under clock
 * skew and misses them under fast edits. Covers exactly the fields a push
 * sends, so a change the push would carry is a change the hash sees.
 */
export function taskContentHash(task: {
  readonly title: string
  readonly description: Record<string, unknown>
  readonly acceptanceCriteria: readonly { readonly text: string }[]
  readonly tags: readonly string[]
  readonly status: string
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        title: task.title,
        description: task.description,
        criteria: task.acceptanceCriteria.map((c) => c.text),
        tags: [...task.tags].sort(),
        status: task.status,
      }),
    )
    .digest('hex')
}

/** The description a push sends: the task's criteria as a checklist. */
function descriptionFor(task: {
  readonly acceptanceCriteria: readonly { readonly text: string }[]
}): string {
  if (task.acceptanceCriteria.length === 0) return ''
  return ['## Acceptance criteria', '', ...task.acceptanceCriteria.map((c) => `- [ ] ${c.text}`)].join('\n')
}

export function createTaskPushService(
  config: DbConfig,
  deps: { readonly tasks: TaskService; readonly sink: TrackerSink },
): TaskPushService {
  async function trackerIntegration(t: TenantTx): Promise<{ id: string } | undefined> {
    const [row] = await t.query<{ id: string }>(
      `SELECT id FROM integrations
        WHERE kind = ANY($1) AND deleted_at IS NULL
        ORDER BY created_at
        LIMIT 1`,
      [TRACKER_KINDS],
    )
    return row
  }

  return {
    async push({ workspaceId, taskId, actorId }) {
      const task = await deps.tasks.get(workspaceId, taskId)
      const hash = taskContentHash(task)
      const title = task.title
      const description = descriptionFor(task)

      // The integration and any existing link are read in their own tenant
      // transaction before the external write, so an unknown tracker is a clean
      // refusal rather than an error after an issue was already created.
      const integration = await withTenant(workspaceId, (t) => trackerIntegration(t), { config })
      if (!integration) {
        throw new ValidationError('This workspace has no connected tracker to push to', {
          field: 'integration',
        })
      }

      const existing = await withTenant(
        workspaceId,
        (t) =>
          t
            .query<{ external_id: string }>(
              `SELECT external_id FROM task_tracker_links WHERE task_id = $1 AND integration_id = $2`,
              [taskId, integration.id],
            )
            .then((rows) => rows[0]),
        { config },
      )

      // Stable per (task, integration): the key the connector stamps so a
      // lost-response create is found rather than remade (AC4).
      const idempotencyKey = `task-push:${taskId}`
      const ref = existing
        ? await deps.sink.updateIssue({
            workspaceId,
            teamId: task.teamId,
            integrationId: integration.id,
            externalId: existing.external_id,
            title,
            description,
            idempotencyKey,
          })
        : await deps.sink.createIssue({
            workspaceId,
            teamId: task.teamId,
            integrationId: integration.id,
            title,
            description,
            idempotencyKey,
          })

      // Upserted, so a race between a double-click and a replay cannot write two
      // links, and audited in the same transaction as the write it records.
      return withTenant(
        workspaceId,
        (t) =>
          mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            action: 'task.push',
            targetType: 'task',
            targetId: taskId,
            before: existing ? { externalId: existing.external_id } : {},
            after: { externalId: ref.externalId, externalKey: ref.key ?? null },
            apply: () =>
              t.query<{
                task_id: string
                integration_id: string
                external_id: string
                external_key: string | null
                external_url: string | null
                sync_state: 'synced' | 'pending' | 'conflict'
              }>(
                `INSERT INTO task_tracker_links
                   (id, workspace_id, task_id, integration_id, external_id, external_key, external_url, sync_state, last_synced_hash)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'synced', $8)
                 ON CONFLICT (task_id, integration_id) DO UPDATE
                   SET external_id = EXCLUDED.external_id,
                       external_key = EXCLUDED.external_key,
                       external_url = EXCLUDED.external_url,
                       sync_state = 'synced',
                       last_synced_hash = EXCLUDED.last_synced_hash,
                       updated_at = now()
                 RETURNING task_id, integration_id, external_id, external_key, external_url, sync_state`,
                [
                  ulid(),
                  workspaceId,
                  taskId,
                  integration.id,
                  ref.externalId,
                  ref.key ?? null,
                  ref.url ?? null,
                  hash,
                ],
              ),
          }),
        { config, userId: actorId },
      ).then(([row]) => {
        if (!row) throw new NotFoundError('The task tracker link could not be written', { taskId })
        return {
          taskId: row.task_id,
          integrationId: row.integration_id,
          externalId: row.external_id,
          externalKey: row.external_key,
          externalUrl: row.external_url,
          syncState: row.sync_state,
        }
      })
    },
  }
}
