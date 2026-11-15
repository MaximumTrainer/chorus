import { createHash } from 'node:crypto'
import { withTenant, type DbConfig } from '@chorus/db'

/**
 * Exporting everything a workspace owns (NFR-4 AC4).
 *
 * The format, `chorus-export/v1`, is newline-delimited JSON, one object per
 * line, written as it is read so a workspace with years of signals never has to
 * fit in memory:
 *
 * - first, a `header` naming the format, the workspace and when;
 * - then one `row` line per row, `{ type, table, row }`, table by table;
 * - last, a `manifest`: for every exported table its row count, the SHA-256 of
 *   its row lines (each line's exact text plus `\n`, in order) and any columns
 *   held back; the tables excluded and why; and the SHA-256 of every row line in
 *   the export. A reader can recompute every checksum from the lines alone.
 *
 * "Everything" is decided by the schema, not a list: every table carrying
 * `workspace_id` is exported, read inside the workspace's own tenant context,
 * unless it is excluded here with a reason. What is excluded or held back is
 * secret material — wrapped data keys, encrypted credentials, token and state
 * hashes, PKCE verifiers — which is useless off this deployment and dangerous
 * on any other. Binary columns are written as `{ "$base64": … }`.
 *
 * Tables are read in chunks, each in its own short transaction, so the export
 * is not one point-in-time snapshot across tables: rows written while it runs
 * may or may not appear. For a workspace at rest it is complete.
 */

export const EXPORT_FORMAT = 'chorus-export/v1'

const CHUNK = 500

/** Tables that are never exported, and why — written into every manifest. */
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  workspace_data_keys: 'The workspace data-encryption keys, wrapped by this deployment: key material, not content.',
  account_link_requests: 'In-flight account-link requests: minutes-long, and they hold PKCE verifiers.',
  collaboration_tickets: 'Short-lived editor join tickets: credentials, not content.',
}

/** Columns never exported: secrets, or proofs of secrets. Named in the manifest when held back. */
const SECRET_COLUMN =
  /^(encrypted_credentials|wrapped_key|code_verifier|token_hash|state_hash|client_secret_hash|password|password_hash|access_token|refresh_token|id_token)$/

/** An identifier read from the catalogue, checked before it is put into SQL. */
function identifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unexpected identifier in catalogue: ${name}`)
  return name
}

/** JSON-safe: binary as base64, everything else as JSON already writes it. */
function encode(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Uint8Array ? { $base64: Buffer.from(value).toString('base64') } : value
  }
  return out
}

export interface WorkspaceExport {
  /** The export, as the lines to write, in order — each ending in `\n`. */
  stream(input: { readonly workspaceId: string }): AsyncGenerator<string>
}

export function createWorkspaceExport(config: DbConfig, options: { readonly now?: () => Date } = {}): WorkspaceExport {
  const now = options.now ?? (() => new Date())
  const tx = <T>(workspaceId: string, fn: Parameters<typeof withTenant<T>>[1]) => withTenant(workspaceId, fn, { config })

  return {
    async *stream({ workspaceId }) {
      const exportedAt = now().toISOString()
      yield `${JSON.stringify({ type: 'header', format: EXPORT_FORMAT, workspaceId, exportedAt })}\n`

      const columns = await tx(workspaceId, (t) =>
        t.query<{ table_name: string; column_name: string }>(
          `SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name IN (SELECT table_name FROM information_schema.columns
                                  WHERE table_schema = 'public' AND column_name = 'workspace_id')
            ORDER BY table_name, ordinal_position`,
        ),
      )
      const byTable = new Map<string, string[]>()
      for (const { table_name, column_name } of columns) {
        byTable.set(table_name, [...(byTable.get(table_name) ?? []), column_name])
      }

      const all = createHash('sha256')
      const tables: Record<string, { rows: number; sha256: string; omittedColumns: string[] }> = {}
      const excludedTables: Record<string, string> = {}

      for (const table of [...byTable.keys()].sort()) {
        const reason = EXCLUDED_TABLES[table]
        if (reason) {
          excludedTables[table] = reason
          continue
        }
        const cols = byTable.get(table)!
        const kept = cols.filter((c) => !SECRET_COLUMN.test(c)).map(identifier)
        const omittedColumns = cols.filter((c) => SECRET_COLUMN.test(c))
        const select = kept.map((c) => `"${c}"`).join(', ')
        const name = identifier(table)
        const hash = createHash('sha256')
        let rows = 0

        const emit = function* (batch: Record<string, unknown>[]): Generator<string> {
          for (const row of batch) {
            const line = `${JSON.stringify({ type: 'row', table, row: encode(row) })}\n`
            hash.update(line)
            all.update(line)
            rows += 1
            yield line
          }
        }

        if (kept.includes('id')) {
          // Keyset pages: each a short transaction, none holding the table.
          let after: string | null = null
          for (;;) {
            const batch: Record<string, unknown>[] = await tx(workspaceId, (t) =>
              t.query<Record<string, unknown>>(
                `SELECT ${select} FROM ${name}
                  WHERE workspace_id = $1 AND ($2::text IS NULL OR id > $2)
                  ORDER BY id LIMIT ${CHUNK}`,
                [workspaceId, after],
              ),
            )
            yield* emit(batch)
            if (batch.length < CHUNK) break
            after = String(batch[batch.length - 1]!.id)
          }
        } else {
          yield* emit(
            await tx(workspaceId, (t) =>
              t.query<Record<string, unknown>>(`SELECT ${select} FROM ${name} WHERE workspace_id = $1`, [workspaceId]),
            ),
          )
        }
        tables[table] = { rows, sha256: hash.digest('hex'), omittedColumns }
      }

      yield `${JSON.stringify({
        type: 'manifest',
        format: EXPORT_FORMAT,
        workspaceId,
        exportedAt,
        tables,
        excludedTables,
        sha256: all.digest('hex'),
      })}\n`
    },
  }
}
