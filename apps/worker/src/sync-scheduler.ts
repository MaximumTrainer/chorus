import { withTenant, type DbConfig } from '@chorus/db'
import type { Queue } from '@chorus/queue'
import { SYNC_INTEGRATION_QUEUE, type SyncIntegrationJob } from './consumers/sync-integration.js'

/**
 * The ingestion schedule (BRAIN-1).
 *
 * Each tick enqueues one sync for every connected source integration. Ticks can
 * be frequent; the interval is what bounds how often a source is asked: a job's
 * idempotency key names the integration and the interval it falls in, so every
 * tick within one interval collapses into a single sync. Were a key ever
 * forgotten by the queue, the cost would be a redundant sync, which is harmless
 * — the sync itself is idempotent.
 *
 * Workspaces are enumerated outside any tenant (they are not a tenant table) and
 * each one's integrations are read inside its own tenant context: a cross-tenant
 * operation, never a cross-tenant read — the same rule key rotation follows.
 */

export interface SyncScheduler {
  tick(now: Date): Promise<{ readonly enqueued: number }>
}

export function createSyncScheduler(deps: {
  readonly dbConfig: DbConfig
  readonly queue: Queue
  /** The integration kinds this worker has a source connector for. */
  readonly kinds: readonly string[]
  readonly intervalMs: number
}): SyncScheduler {
  return {
    async tick(now) {
      const slot = Math.floor(now.getTime() / deps.intervalMs)
      const workspaces = await withTenant(
        '__none__',
        (t) => t.query<{ id: string }>(`SELECT id FROM workspaces WHERE deleted_at IS NULL`),
        { config: deps.dbConfig },
      )

      let enqueued = 0
      for (const workspace of workspaces) {
        const integrations = await withTenant(
          workspace.id,
          (t) =>
            t.query<{ id: string }>(
              `SELECT id FROM integrations
                WHERE kind = ANY($1) AND status <> 'disconnected' AND deleted_at IS NULL
                ORDER BY id`,
              [[...deps.kinds]],
            ),
          { config: deps.dbConfig },
        )
        for (const integration of integrations) {
          const job: SyncIntegrationJob = { workspaceId: workspace.id, integrationId: integration.id }
          await deps.queue.enqueue(SYNC_INTEGRATION_QUEUE, job, {
            idempotencyKey: `sync-${integration.id}-slot-${slot}`,
          })
          enqueued += 1
        }
      }
      return { enqueued }
    },
  }
}
