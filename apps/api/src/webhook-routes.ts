import { route, type RouteDefinition } from './routes.js'
import type { TaskSyncService } from './task-sync.js'
import type { TrackerWebhook } from './tracker-webhook.js'

/**
 * The inbound tracker webhook (TASK-4 AC2).
 *
 * `public`: the caller is the tracker, not a Chorus user, and the delivery
 * authenticates itself by signature — the gateway verifies it before anything
 * is acted on. The route's own job is small: hand the delivery to the gateway,
 * then mirror each status change it reports onto the mapped task. A delivery
 * that was a duplicate, a forgery, or carried no status change leaves nothing
 * to mirror and changes nothing.
 *
 * Mounted only when both the webhook gateway and the sync service are wired;
 * without a tracker there is nothing for it to do, and an unauthenticated route
 * that does nothing is better left off than left answering.
 */
export function webhookRoutes(webhook?: TrackerWebhook, sync?: TaskSyncService): RouteDefinition[] {
  if (!webhook || !sync) return []
  return [
    route({
      method: 'POST',
      path: '/webhooks/:integrationId',
      summary: 'Receive a tracker webhook and mirror any status change onto the mapped task.',
      auth: {
        kind: 'public',
        reason: 'A tracker delivery is authenticated by its signature, which the gateway verifies.',
      },
      handler: async (c) => {
        const integrationId = c.req.param('integrationId')
        const body = await c.req.text()
        const headers: Record<string, string> = {}
        c.req.raw.headers.forEach((value, name) => {
          headers[name] = value
        })

        const delivery = await webhook.handle(integrationId, { headers, body })

        // Mirror each change the delivery carried. The gateway found the
        // integration and its workspace; the mirror finds the task from the
        // issue's id and applies the map, holding a conflict rather than
        // overwriting (AC3). No workspace means the delivery resolved to
        // nothing, and it carried no changes either.
        const mirrored: Array<{ externalId: string; result: string }> = []
        if (delivery.workspaceId) {
          for (const change of delivery.changes) {
            const outcome = await sync.mirrorInbound({
              workspaceId: delivery.workspaceId,
              integrationId,
              externalId: change.externalId,
              externalStatus: change.externalStatus,
            })
            mirrored.push({ externalId: change.externalId, result: outcome.result })
          }
        }

        return c.json({ state: delivery.state, mirrored })
      },
    }),
  ]
}
