import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'
import { createEntityStore, type EntityStore } from './entities.js'

/**
 * Self-organisation: the nightly jobs that keep the graph from degrading
 * (BRAIN-7). They **propose, never apply** — an automatic merge that is wrong
 * is very hard to notice and very annoying to undo — so each lands a review
 * item, evidenced, for a human to decide (NAV-3). This slice is the merge
 * detector; split, stale and contradiction follow.
 */

/** At or above this name similarity, two same-kind entities are proposed as the same thing. */
export const MERGE_PROPOSAL_THRESHOLD = 0.6

export interface MergeDetector {
  /** Finds likely-duplicate entities and opens a `merge` review item for each new pair. */
  detect(workspaceId: string): Promise<{ readonly proposed: number }>
}

export function createMergeDetector(
  config: DbConfig,
  options: { readonly threshold?: number } = {},
): MergeDetector {
  const threshold = options.threshold ?? MERGE_PROPOSAL_THRESHOLD
  const store: EntityStore = createEntityStore(config)
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>) =>
    withTenant(workspaceId, fn, { config })

  return {
    async detect(workspaceId) {
      // Candidate pairs: same kind, ordered so each pair is considered once,
      // similar enough by name to be worth a human's attention. Trigram, like
      // extraction's resolution, so the two agree on what "similar" means.
      const pairs = await tx(workspaceId, (t) =>
        t.query<{ a: string; a_name: string; b: string; b_name: string; score: number }>(
          `SELECT x.id AS a, x.name AS a_name, y.id AS b, y.name AS b_name, similarity(x.name, y.name) AS score
             FROM entities x
             JOIN entities y ON x.kind = y.kind AND x.id < y.id
            WHERE similarity(x.name, y.name) >= $1
            ORDER BY score DESC`,
          [threshold],
        ),
      )

      // The pairs already proposed, so a second run does not raise the same
      // item again (the detector is scheduled and will see these entities
      // nightly until a human decides).
      const open = await store.reviewItems(workspaceId)
      const existing = new Set(
        open
          .filter((item) => item.kind === 'merge')
          .map((item) => {
            const s = item.subject as { winner?: { entityId?: string }; loser?: { entityId?: string } }
            return [s.winner?.entityId, s.loser?.entityId].sort().join('|')
          }),
      )

      let proposed = 0
      for (const pair of pairs) {
        // The older entity (smaller id) is the winner — it has been around
        // longer, so references to it are the ones more expensive to rewrite.
        const key = [pair.a, pair.b].sort().join('|')
        if (existing.has(key)) continue
        await store.openReviewItem({
          workspaceId,
          kind: 'merge',
          subject: {
            winner: { entityId: pair.a, name: pair.a_name },
            loser: { entityId: pair.b, name: pair.b_name },
            score: Number(pair.score),
            detector: 'merge',
          },
        })
        existing.add(key)
        proposed += 1
      }
      return { proposed }
    },
  }
}
