import { NotFoundError, ulid } from '@chorus/core'
import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Erasing a workspace completely (NFR-4 AC5, AC6).
 *
 * One transaction does three things. It deletes the workspace, which cascades
 * through every table that references it. It then sweeps every table carrying
 * `workspace_id` — discovered from the schema, not from a list someone keeps —
 * so a table that holds workspace data without a cascading foreign key is
 * cleared too. And it verifies: every such table is counted, and any that still
 * holds a row is residue. Residue fails the erasure and rolls it all back,
 * because "mostly erased" is not erased, and a half-done erasure that reported
 * success would be the worst outcome. Vector rows are rows, so they go the same
 * way; there is no object storage or cache keyed by workspace to clear yet.
 *
 * The workspace's audit trail is part of what is erased, so the erasure is
 * recorded in `workspace_erasures`, outside the tenant model, in the same
 * transaction: no erasure without its record, no record without its erasure.
 *
 * Who may erase, and the confirmation, are the route's concern (AC6).
 */

export interface ErasureOutcome {
  readonly tablesVerified: number
  /** Tables still holding rows of the workspace. Always empty for a completed erasure. */
  readonly residue: readonly string[]
}

export interface WorkspaceErasure {
  erase(input: { readonly workspaceId: string; readonly actorId: string }): Promise<ErasureOutcome>
}

/** A table name read from the catalogue, checked before it is put into SQL. */
function safeIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unexpected table name in catalogue: ${name}`)
  return name
}

export class ErasureIncompleteError extends Error {
  constructor(readonly residue: readonly string[]) {
    super(`Erasure left rows behind in: ${residue.join(', ')}`)
  }
}

export function createWorkspaceErasure(config: DbConfig): WorkspaceErasure {
  return {
    async erase({ workspaceId, actorId }) {
      return withTenant(
        workspaceId,
        async (t: TenantTx) => {
          const [workspace] = await t.query<{ name: string }>(
            `SELECT name FROM workspaces WHERE id = $1 FOR UPDATE`,
            [workspaceId],
          )
          if (!workspace) throw new NotFoundError('No such workspace', { workspaceId })

          const tables = (
            await t.query<{ table_name: string }>(
              `SELECT table_name FROM information_schema.columns
                WHERE table_schema = 'public' AND column_name = 'workspace_id'
                ORDER BY table_name`,
            )
          ).map((r) => safeIdentifier(r.table_name))

          await t.execute(`DELETE FROM workspaces WHERE id = $1`, [workspaceId])
          // Anything not reached by a cascading foreign key.
          for (const table of tables) {
            await t.execute(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId])
          }

          const residue: string[] = []
          for (const table of tables) {
            const [row] = await t.query<{ n: string }>(
              `SELECT count(*) AS n FROM ${table} WHERE workspace_id = $1`,
              [workspaceId],
            )
            if (Number(row!.n) > 0) residue.push(table)
          }
          if (residue.length > 0) throw new ErasureIncompleteError(residue)

          await t.execute(
            `INSERT INTO workspace_erasures
               (id, erased_workspace_id, workspace_name, erased_by, tables_verified, residue)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [ulid(), workspaceId, workspace.name, actorId, tables.length, JSON.stringify(residue)],
          )
          return { tablesVerified: tables.length, residue }
        },
        { config },
      )
    },
  }
}
