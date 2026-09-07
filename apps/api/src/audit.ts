import { ValidationError } from '@chorus/core'
import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Reading the audit log (WS-6).
 *
 * The writing half has existed since 0001: `mutate` puts the row in the same
 * transaction as the change. This is the surface, and the requirement is blunt
 * about why it matters — "the log is worthless if it cannot be read", and it is
 * the tool for answering "why did the agent do that?", which will be the most
 * common support question this product ever receives.
 *
 * Three things make it usable when somebody is upset: finding the entry,
 * trusting the page boundaries, and getting the whole set out.
 */

export interface AuditEntry {
  readonly id: string
  readonly actorType: string
  readonly actorId: string | null
  readonly action: string
  readonly targetType: string
  readonly targetId: string | null
  readonly before: unknown
  readonly after: unknown
  readonly at: string
}

export interface AuditQuery {
  readonly actorId?: string
  readonly actorType?: string
  readonly action?: string
  readonly targetId?: string
  readonly from?: string
  readonly to?: string
  readonly limit?: number
  readonly cursor?: string
}

export interface AuditPage {
  readonly entries: readonly AuditEntry[]
  /** Absent when this is the last page. */
  readonly nextCursor: string | null
}

export interface AuditService {
  query(workspaceId: string, query: AuditQuery): Promise<AuditPage>
  /**
   * The same set, streamed.
   *
   * A generator rather than an array, because an export of a year's activity
   * must not be assembled in memory first (AC4). The route writes each chunk as
   * it arrives.
   */
  stream(workspaceId: string, query: AuditQuery): AsyncGenerator<AuditEntry>
}

const MAX_PAGE = 500

interface Row {
  id: string
  actor_type: string
  actor_id: string | null
  action: string
  target_type: string
  target_id: string | null
  before: unknown
  after: unknown
  at: Date
}

const toEntry = (row: Row): AuditEntry => ({
  id: row.id,
  actorType: row.actor_type,
  actorId: row.actor_id,
  action: row.action,
  targetType: row.target_type,
  targetId: row.target_id,
  before: row.before,
  after: row.after,
  at: row.at.toISOString(),
})

/**
 * The `WHERE` clause and its parameters.
 *
 * The cursor is the last id of the previous page, and paging is **keyset**:
 * `id < $cursor` on a ULID, which sorts the same way as the timestamp it
 * embeds. An offset would shift under a concurrent write and silently skip a
 * row — in an audit log, the one outcome nobody can accept, and the one a
 * reader has no way to notice.
 */
function where(query: AuditQuery): { sql: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  const bind = (value: unknown): string => {
    params.push(value)
    return `$${params.length}`
  }

  if (query.actorId) clauses.push(`actor_id = ${bind(query.actorId)}`)
  if (query.actorType) clauses.push(`actor_type = ${bind(query.actorType)}`)
  if (query.action) clauses.push(`action = ${bind(query.action)}`)
  if (query.targetId) clauses.push(`target_id = ${bind(query.targetId)}`)
  if (query.from) clauses.push(`at >= ${bind(query.from)}::timestamptz`)
  if (query.to) clauses.push(`at <= ${bind(query.to)}::timestamptz`)
  if (query.cursor) clauses.push(`id < ${bind(query.cursor)}`)

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  }
}

const COLUMNS = `id, actor_type, actor_id, action, target_type, target_id, before, after, at`

export function createAuditService(config: DbConfig): AuditService {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>): Promise<T> =>
    withTenant(workspaceId, fn, { config })

  return {
    async query(workspaceId, query) {
      const limit = Math.min(query.limit ?? 50, MAX_PAGE)
      if (limit < 1) throw new ValidationError('limit must be at least 1', { field: 'limit' })

      const { sql, params } = where(query)
      const rows = await tx(workspaceId, (t) =>
        t.query<Row>(
          // One more than asked for, so "is there another page" is answered by
          // what came back rather than by a second count query that can
          // disagree with it.
          `SELECT ${COLUMNS} FROM audit_events ${sql} ORDER BY id DESC LIMIT ${limit + 1}`,
          params,
        ),
      )

      const page = rows.slice(0, limit)
      return {
        entries: page.map(toEntry),
        nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      }
    },

    async *stream(workspaceId, query) {
      // Paged internally rather than one unbounded cursor: a long-running
      // transaction over a table this write-heavy would hold a snapshot open
      // for the length of the download.
      let cursor = query.cursor
      for (;;) {
        const page = await this.query(workspaceId, {
          ...query,
          // Spread conditionally: `exactOptionalPropertyTypes` treats an
          // explicit `undefined` as different from an absent key, and the
          // first page genuinely has no cursor.
          ...(cursor === undefined ? {} : { cursor }),
          limit: MAX_PAGE,
        })
        for (const entry of page.entries) yield entry
        if (!page.nextCursor) return
        cursor = page.nextCursor
      }
    },
  }
}

/** The export's columns, in a fixed order so a diff of two exports is readable. */
export const AUDIT_CSV_COLUMNS = [
  'id',
  'at',
  'actorType',
  'actorId',
  'action',
  'targetType',
  'targetId',
] as const

export function toCsvRow(entry: AuditEntry): string {
  return AUDIT_CSV_COLUMNS.map((column) => {
    const value = entry[column]
    const text = value === null || value === undefined ? '' : String(value)
    // Quoted whenever it could be misread. An action is a dotted verb and an
    // id is a ULID, so this rarely fires — but an export that breaks on the
    // one row containing a comma is worse than one that always quotes.
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }).join(',')
}
