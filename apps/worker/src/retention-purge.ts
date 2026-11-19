import { retentionCutoff, type RetentionClass } from '@chorus/core'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * The retention purge (NFR-4 AC3, WS-7 AC4, architecture.md §20).
 *
 * Each run removes, for every workspace, whatever has outlived the period its
 * owner set for that class. A class with no period is left alone. Each class
 * is purged in its own transaction with its own audit row, so one class
 * failing never leaves another half-done, and the log says which class went,
 * under what period, up to what moment, and how much.
 *
 * Idempotent by construction: it removes what is past the cutoff, and once it
 * has, a second run at the same moment finds nothing and records nothing. A
 * purge that found nothing is not audited, or the log would fill with a row
 * per class per workspace per tick and bury the purges that mattered.
 *
 * Workspaces are enumerated outside any tenant (they are not a tenant table);
 * every read and write after that is inside the workspace's own context.
 */

export interface RetentionPurge {
  run(now: Date): Promise<void>
}

interface ClassPurge {
  /** How many rows are past the cutoff and would change. */
  count(t: TenantTx, cutoff: Date): Promise<number>
  apply(t: TenantTx, cutoff: Date): Promise<number>
}

/** The bodies a model call may carry; everything else in its payload is structure. */
const BODY_KEYS = ['prompt', 'response']

const PURGES: Record<RetentionClass, ClassPurge> = {
  // The trace goes; the run, and the spend ledger its cost reconciles against,
  // stay. "What ran and what did it cost" outlives "what exactly happened".
  run_traces: {
    async count(t, cutoff) {
      const [row] = await t.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM run_events WHERE at < $1`,
        [cutoff],
      )
      return row?.n ?? 0
    },
    apply: (t, cutoff) => t.execute(`DELETE FROM run_events WHERE at < $1`, [cutoff]),
  },
  // The bodies go; the call's structural record — model, tokens, cost, and the
  // hashes that let a reconstruction be verified — stays.
  prompts: {
    async count(t, cutoff) {
      const [row] = await t.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM run_events
          WHERE kind = 'model_call' AND at < $1 AND payload ?| $2`,
        [cutoff, BODY_KEYS],
      )
      return row?.n ?? 0
    },
    apply: (t, cutoff) =>
      t.execute(
        `UPDATE run_events SET payload = payload - $2::text[]
          WHERE kind = 'model_call' AND at < $1 AND payload ?| $2`,
        [cutoff, BODY_KEYS],
      ),
  },
}

/**
 * Traces before prompts: a body inside an event that is about to be deleted is
 * not worth a separate purge or a separate line in the log.
 */
const ORDER: readonly RetentionClass[] = ['run_traces', 'prompts']

export function createRetentionPurge(deps: { readonly dbConfig: DbConfig }): RetentionPurge {
  const inTenant = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>) =>
    withTenant(workspaceId, fn, { config: deps.dbConfig })

  return {
    async run(now) {
      const workspaces = await inTenant('__none__', (t) =>
        t.query<{ id: string }>(`SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY id`),
      )

      for (const { id: workspaceId } of workspaces) {
        const periods = await inTenant(workspaceId, (t) =>
          t.query<{ data_class: RetentionClass; days: number }>(
            `SELECT data_class, days FROM retention_policies`,
          ),
        )
        const daysFor = new Map(periods.map((row) => [row.data_class, row.days]))

        for (const dataClass of ORDER) {
          const days = daysFor.get(dataClass)
          if (days === undefined) continue
          const cutoff = retentionCutoff(now, days)
          const purge = PURGES[dataClass]

          await inTenant(workspaceId, async (t) => {
            const due = await purge.count(t, cutoff)
            if (due === 0) return
            await mutate(t, {
              workspaceId,
              actor: { type: 'system' },
              action: 'retention.purge',
              targetType: 'retention_policy',
              targetId: dataClass,
              after: { dataClass, days, cutoff: cutoff.toISOString(), purged: due },
              apply: () => purge.apply(t, cutoff),
            })
          })
        }
      }
    },
  }
}
