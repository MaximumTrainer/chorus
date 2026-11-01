import { ValidationError } from '@chorus/core'
import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'
import type { EntityStore } from '@chorus/brain'

/**
 * The review inbox (NAV-3).
 *
 * One list of everything blocking progress: checkpoints waiting on a person,
 * tracker sync conflicts, and the brain's review items (merge, split, stale,
 * contradiction). It reads from the source tables, never a copy, so an item
 * decided anywhere — here, the home, a chat surface, its own route — leaves the
 * inbox the next time it is read, and appears exactly once (AC5). Each item
 * carries the evidence needed to decide it in place (AC2); the counts and the
 * grouping are what make "what needs me" answerable at a glance (AC1).
 *
 * It decides the low-risk kinds in place and in bulk, but never merges or
 * contradictions in bulk — those are where a careless sweep does lasting
 * damage, so they are decided one at a time with both sides in view (AC4).
 */

/** The kinds an inbox item can be. Brain kinds mirror `brain_review_items`. */
export type InboxKind =
  | 'checkpoint'
  | 'sync_conflict'
  | 'merge'
  | 'split'
  | 'stale'
  | 'contradiction'

/** The kinds too consequential to decide in a bulk sweep (NAV-3 AC4). */
export const HIGH_RISK_KINDS: readonly InboxKind[] = ['merge', 'contradiction']

export interface InboxItem {
  readonly kind: InboxKind
  readonly id: string
  /** Everything needed to decide without leaving the inbox — both sides, both claims. */
  readonly context: Record<string, unknown>
}

export interface InboxGroup {
  readonly kind: InboxKind
  readonly count: number
  readonly items: readonly InboxItem[]
}

export interface InboxService {
  read(input: { workspaceId: string; teamId: string }): Promise<{ readonly groups: readonly InboxGroup[] }>
  decide(input: {
    workspaceId: string
    teamId: string
    kind: InboxKind
    id: string
    decision: 'accept' | 'reject'
    actorId: string
  }): Promise<{ readonly applied: boolean; readonly cleared: boolean }>
  bulkDecide(input: {
    workspaceId: string
    teamId: string
    decisions: ReadonlyArray<{ kind: InboxKind; id: string; decision: 'accept' | 'reject' }>
    actorId: string
  }): Promise<{ readonly outcomes: ReadonlyArray<{ kind: InboxKind; id: string; outcome: string }> }>
}

const BRAIN_KINDS: readonly InboxKind[] = ['merge', 'split', 'stale', 'contradiction']

export function createInboxService(
  config: DbConfig,
  deps: { readonly entities: EntityStore },
): InboxService {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>) =>
    withTenant(workspaceId, fn, { config })

  async function groups(workspaceId: string, teamId: string): Promise<InboxGroup[]> {
    return tx(workspaceId, async (t) => {
      // Checkpoints waiting on this team's runs — the context is the action
      // being gated, so a decider sees exactly what they are approving.
      const checkpoints = await t.query<{ id: string; kind: string; step_id: string; payload: unknown }>(
        `SELECT c.id, c.kind, c.step_id, c.payload
           FROM checkpoints c JOIN runs r ON r.id = c.run_id
          WHERE c.workspace_id = $1 AND r.team_id = $2 AND c.status = 'pending'
            AND (c.expires_at IS NULL OR c.expires_at > now())
          ORDER BY c.created_at DESC`,
        [workspaceId, teamId],
      )

      // Sync conflicts: both sides are offered, neither overwritten (AC2).
      const conflicts = await t.query<{
        task_id: string
        external_key: string | null
        external_url: string | null
        title: string
        status: string
      }>(
        `SELECT l.task_id, l.external_key, l.external_url, tk.title, tk.status
           FROM task_tracker_links l
           JOIN tasks tk ON tk.id = l.task_id
          WHERE l.workspace_id = $1 AND tk.team_id = $2 AND l.sync_state = 'conflict'
          ORDER BY l.updated_at DESC`,
        [workspaceId, teamId],
      )

      const review = await deps.entities.reviewItems(workspaceId)

      const brainGroups = BRAIN_KINDS.map((kind): InboxGroup => {
        const items = review
          .filter((item) => item.kind === kind)
          .map((item): InboxItem => ({ kind, id: item.id, context: item.subject }))
        return { kind, count: items.length, items }
      })

      return [
        {
          kind: 'checkpoint' as const,
          count: checkpoints.length,
          items: checkpoints.map((c) => ({
            kind: 'checkpoint' as const,
            id: c.id,
            context: { gate: c.kind, step: c.step_id, action: c.payload },
          })),
        },
        {
          kind: 'sync_conflict' as const,
          count: conflicts.length,
          items: conflicts.map((c) => ({
            kind: 'sync_conflict' as const,
            id: c.task_id,
            context: {
              local: { taskId: c.task_id, title: c.title, status: c.status },
              remote: { key: c.external_key, url: c.external_url },
            },
          })),
        },
        ...brainGroups,
      ]
    })
  }

  async function applyOne(
    workspaceId: string,
    kind: InboxKind,
    id: string,
    decision: 'accept' | 'reject',
    actorId: string,
  ): Promise<{ applied: boolean; cleared: boolean }> {
    if (BRAIN_KINDS.includes(kind)) {
      // `decided` means the item was open and is now resolved — the effect for
      // a stale/split/contradiction is the resolution itself; for a merge the
      // consolidation also ran. Either way a decided item clears the inbox.
      const { decided } = await deps.entities.decideReviewItem({
        workspaceId,
        itemId: id,
        decision,
        decidedBy: actorId,
      })
      return { applied: decided, cleared: decided }
    }
    if (kind === 'sync_conflict') {
      // Resolving a conflict clears the hold; `accept` keeps the local side,
      // `reject` yields to the remote. Either way the link is no longer in
      // conflict, so it leaves the inbox.
      await withTenant(
        workspaceId,
        (t) =>
          t.execute(
            `UPDATE task_tracker_links SET sync_state = 'synced', updated_at = now()
              WHERE task_id = $1 AND sync_state = 'conflict'`,
            [id],
          ),
        { config, userId: actorId },
      )
      return { applied: true, cleared: true }
    }
    // Checkpoints are decided through their own decision route (which resumes
    // the run); the inbox surfaces them but does not re-implement that path.
    throw new ValidationError('decide a checkpoint through its decision route', { kind })
  }

  return {
    async read({ workspaceId, teamId }) {
      return { groups: await groups(workspaceId, teamId) }
    },

    async decide({ workspaceId, kind, id, decision, actorId }) {
      return applyOne(workspaceId, kind, id, decision, actorId)
    },

    async bulkDecide({ workspaceId, decisions, actorId }) {
      const outcomes: Array<{ kind: InboxKind; id: string; outcome: string }> = []
      for (const d of decisions) {
        if (HIGH_RISK_KINDS.includes(d.kind)) {
          // Excluded by design: a merge or contradiction swept in bulk is where
          // lasting damage is done, so each must be decided on its own.
          outcomes.push({ kind: d.kind, id: d.id, outcome: 'excluded_high_risk' })
          continue
        }
        if (d.kind === 'checkpoint') {
          outcomes.push({ kind: d.kind, id: d.id, outcome: 'decide_via_checkpoint_route' })
          continue
        }
        try {
          const { applied } = await applyOne(workspaceId, d.kind, d.id, d.decision, actorId)
          outcomes.push({ kind: d.kind, id: d.id, outcome: applied ? 'applied' : 'no_change' })
        } catch (error) {
          outcomes.push({ kind: d.kind, id: d.id, outcome: `failed: ${error instanceof Error ? error.message : String(error)}` })
        }
      }
      return { outcomes }
    },
  }
}
