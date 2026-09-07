import { ValidationError } from '@chorus/core'
import { route, type RouteDefinition } from './routes.js'
import { AUDIT_CSV_COLUMNS, toCsvRow, type AuditQuery, type AuditService } from './audit.js'

/**
 * Audit log routes (WS-6).
 *
 * `admin`, both of them. The log names who did what and when, which is exactly
 * the information a colleague has no standing to browse — and AC5 asks for the
 * refusal explicitly rather than leaving it to a UI that happens not to link
 * there.
 */
export function auditRoutes(audit: AuditService): RouteDefinition[] {
  const parse = (url: URL): AuditQuery => {
    const text = (name: string): string | undefined => url.searchParams.get(name) ?? undefined

    const limitParam = text('limit')
    const limit = limitParam === undefined ? undefined : Number(limitParam)
    if (limit !== undefined && !Number.isInteger(limit)) {
      throw new ValidationError('limit must be a whole number', { field: 'limit' })
    }

    for (const field of ['from', 'to'] as const) {
      const value = text(field)
      if (value !== undefined && Number.isNaN(Date.parse(value))) {
        // Refused rather than ignored. A mistyped date that is silently
        // dropped returns *more* than the reader asked for, and an audit
        // answer that is quietly wider than the question is a wrong answer.
        throw new ValidationError(`${field} must be a timestamp`, { field })
      }
    }

    return {
      ...(text('actorId') ? { actorId: text('actorId')! } : {}),
      ...(text('actorType') ? { actorType: text('actorType')! } : {}),
      ...(text('action') ? { action: text('action')! } : {}),
      ...(text('targetId') ? { targetId: text('targetId')! } : {}),
      ...(text('from') ? { from: text('from')! } : {}),
      ...(text('to') ? { to: text('to')! } : {}),
      ...(text('cursor') ? { cursor: text('cursor')! } : {}),
      ...(limit === undefined ? {} : { limit }),
    }
  }

  return [
    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/audit',
      summary: 'Read the audit log, filtered and paged.',
      auth: { kind: 'workspace', role: 'admin', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(await audit.query(c.req.param('workspaceId'), parse(new URL(c.req.url)))),
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/audit/export',
      summary: 'Export the filtered audit log as JSON Lines or CSV.',
      auth: { kind: 'workspace', role: 'admin', scopes: ['read:artefacts'] },
      handler: async (c) => {
        const url = new URL(c.req.url)
        const format = url.searchParams.get('format') ?? 'jsonl'
        if (format !== 'jsonl' && format !== 'csv') {
          throw new ValidationError('format must be "jsonl" or "csv"', { field: 'format' })
        }

        const workspaceId = c.req.param('workspaceId')
        const query = parse(url)
        const encoder = new TextEncoder()

        // Streamed, not buffered (AC4). An export of a year's activity that is
        // assembled in memory first is one that fails on exactly the range
        // somebody needed it for.
        const body = new ReadableStream({
          async start(controller) {
            try {
              if (format === 'csv') {
                controller.enqueue(encoder.encode(`${AUDIT_CSV_COLUMNS.join(',')}\n`))
              }
              for await (const entry of audit.stream(workspaceId, query)) {
                controller.enqueue(
                  encoder.encode(
                    format === 'csv' ? `${toCsvRow(entry)}\n` : `${JSON.stringify(entry)}\n`,
                  ),
                )
              }
            } catch (error) {
              // A truncated export must not look complete. The stream carries
              // no status code of its own once it has started, so the failure
              // is written into it where a reader — or a diff — will see it.
              controller.enqueue(
                encoder.encode(
                  `\n#ERROR ${error instanceof Error ? error.message : String(error)}\n`,
                ),
              )
            } finally {
              controller.close()
            }
          },
        })

        return new Response(body, {
          headers: {
            'content-type':
              format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
            'content-disposition': `attachment; filename="chorus-audit.${format === 'csv' ? 'csv' : 'jsonl'}"`,
            'cache-control': 'no-store',
          },
        })
      },
    }),
  ]
}
