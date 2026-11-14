import { ValidationError } from '@chorus/core'
import { mutate, withTenant, type DbConfig } from '@chorus/db'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'
import type { WorkspaceService } from './workspaces.js'
import type { WorkspaceExport } from './workspace-export.js'

/**
 * Exporting a workspace (NFR-4 AC4, AC6).
 *
 * An export is everything the workspace owns, so it is gated like erasure:
 * `owner` only, `sessionOnly`, and confirmed by typing the slug back. It is
 * audited before the first byte leaves — an export that failed half way still
 * happened, as far as the record of who took what is concerned. The body
 * streams (`chorus-export/v1`, newline-delimited JSON) as a download.
 */
export function workspaceExportRoutes(
  config: DbConfig,
  exporter: WorkspaceExport,
  workspaces: WorkspaceService,
): RouteDefinition[] {
  return [
    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/export',
      summary: 'Download everything this workspace owns, with a manifest and checksums. Requires typing its slug back.',
      auth: { kind: 'workspace', role: 'owner', scopes: ['read:artefacts'], sessionOnly: true },
      handler: async (c) => {
        const workspaceId = c.req.param('workspaceId')
        const { userId } = caller(c)
        const body = (await c.req.json().catch(() => ({}))) as { confirm?: unknown }
        const { slug } = await workspaces.get(workspaceId, userId)
        if (typeof body.confirm !== 'string' || body.confirm !== slug) {
          throw new ValidationError(
            `To export this workspace, confirm with its slug: send { "confirm": "${slug}" }.`,
            { field: 'confirm' },
          )
        }

        await withTenant(
          workspaceId,
          (t) =>
            mutate(t, {
              workspaceId,
              actor: { type: 'user', id: userId },
              action: 'workspace.export',
              targetType: 'workspace',
              targetId: workspaceId,
              apply: async () => undefined,
            }),
          { config },
        )

        const lines = exporter.stream({ workspaceId })
        const encoder = new TextEncoder()
        const body$ = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await lines.next()
            if (next.done) controller.close()
            else controller.enqueue(encoder.encode(next.value))
          },
          async cancel() {
            await lines.return(undefined)
          },
        })
        const date = new Date().toISOString().slice(0, 10)
        return new Response(body$, {
          status: 200,
          headers: {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'content-disposition': `attachment; filename="chorus-export-${slug}-${date}.ndjson"`,
          },
        })
      },
    }),
  ]
}
