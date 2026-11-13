import { ulid } from '@chorus/core'
import { mutate, withTenant, type Actor, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Which source permission scopes a user holds (NFR-4 AC1, AND1).
 *
 * A signal's scope is captured at ingest; retrieval and the brain map refuse a
 * restricted signal to a caller holding none of its scopes. This records the
 * scopes each user *does* hold — written by a connector's membership sync — so
 * content restricted to a group is visible to that group and nobody else.
 *
 * Read by user id inside the retriever and the map (`heldScopes`), so every
 * path inherits one answer: no caller has to resolve or pass a user's scopes,
 * and none can forget to.
 */

export interface ScopeMemberships {
  /**
   * Replace a user's memberships *from one source* with exactly `scopeIds`.
   * Scopes the source no longer reports are removed, so losing access upstream
   * takes effect on the next retrieval (AND1); other sources' scopes are left
   * alone. Idempotent, and audited in the same transaction — a sync that
   * changed nothing is recorded too, so "nothing changed" is on the record.
   */
  replace(input: {
    readonly workspaceId: string
    readonly userId: string
    readonly source: string
    readonly scopeIds: readonly string[]
    readonly actor: Actor
  }): Promise<{ readonly added: number; readonly removed: number }>
  /** Every scope a user holds, from every source. */
  scopesFor(workspaceId: string, userId: string): Promise<string[]>
}

/**
 * The scopes a user holds, read inside the caller's own tenant transaction so
 * the permission predicate and the memberships it relies on are one snapshot.
 */
export async function heldScopes(t: TenantTx, userId: string): Promise<string[]> {
  const rows = await t.query<{ scope_id: string }>(
    `SELECT scope_id FROM source_scope_memberships WHERE user_id = $1`,
    [userId],
  )
  return rows.map((r) => r.scope_id)
}

/** The scopes a predicate should honour: those held, plus any a caller passed explicitly. */
export async function viewerScopes(
  t: TenantTx,
  userId: string,
  explicit: readonly string[] | undefined,
): Promise<string[]> {
  const held = await heldScopes(t, userId)
  return [...new Set([...held, ...(explicit ?? [])])]
}

export function createScopeMemberships(config: DbConfig): ScopeMemberships {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>): Promise<T> =>
    withTenant(workspaceId, fn, { config })

  return {
    async replace({ workspaceId, userId, source, scopeIds, actor }) {
      const wanted = [...new Set(scopeIds)]
      return tx(workspaceId, async (t) => {
        const before = (
          await t.query<{ scope_id: string }>(
            `SELECT scope_id FROM source_scope_memberships WHERE user_id = $1 AND source = $2`,
            [userId, source],
          )
        ).map((r) => r.scope_id)
        const toRemove = before.filter((scope) => !wanted.includes(scope))
        const toAdd = wanted.filter((scope) => !before.includes(scope))

        return mutate(t, {
          workspaceId,
          actor,
          action: 'source_scope.sync',
          targetType: 'user',
          targetId: userId,
          before: { source, scopeIds: before.sort() },
          after: { source, scopeIds: [...wanted].sort() },
          apply: async () => {
            if (toRemove.length > 0) {
              await t.execute(
                `DELETE FROM source_scope_memberships
                  WHERE user_id = $1 AND source = $2 AND scope_id = ANY($3)`,
                [userId, source, toRemove],
              )
            }
            for (const scope of toAdd) {
              // A scope already held from another source is not taken over:
              // it stays attributed to whichever source asserted it first.
              await t.execute(
                `INSERT INTO source_scope_memberships (id, workspace_id, user_id, source, scope_id)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (workspace_id, user_id, scope_id) DO NOTHING`,
                [ulid(), workspaceId, userId, source, scope],
              )
            }
            return { added: toAdd.length, removed: toRemove.length }
          },
        })
      })
    },

    async scopesFor(workspaceId, userId) {
      return tx(workspaceId, (t) => heldScopes(t, userId))
    },
  }
}
