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

/** An entity with no new evidence in this many days is a candidate for staleness. */
export const STALE_AFTER_DAYS = 30
/** A signal within this many days counts as a current reference to an entity. */
export const REFERENCE_WITHIN_DAYS = 14

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

export interface StaleDetector {
  /** Flags entities with no new evidence but a current reference (BRAIN-7 AC4). */
  detect(workspaceId: string): Promise<{ readonly proposed: number }>
}

export function createStaleDetector(
  config: DbConfig,
  options: { readonly staleAfterDays?: number; readonly referenceWithinDays?: number } = {},
): StaleDetector {
  const staleDays = options.staleAfterDays ?? STALE_AFTER_DAYS
  const referenceDays = options.referenceWithinDays ?? REFERENCE_WITHIN_DAYS
  const store = createEntityStore(config)
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>) =>
    withTenant(workspaceId, fn, { config })

  return {
    async detect(workspaceId) {
      // Stale precisely: the newest evidence is older than the staleness window
      // *and* a recent signal still mentions the entity by name. The second
      // clause is the whole of AC4's precision — an entity that is simply old
      // and unreferenced is not flagged, because nobody is relying on it, and
      // flagging it would make the inbox noise nobody clears.
      const stale = await tx(workspaceId, (t) =>
        t.query<{ id: string; name: string }>(
          `SELECT e.id, e.name
             FROM entities e
            WHERE COALESCE(
                    (SELECT max(ev.created_at) FROM entity_evidence ev WHERE ev.entity_id = e.id),
                    e.created_at
                  ) < now() - ($1 || ' days')::interval
              AND EXISTS (
                SELECT 1 FROM signals s
                 WHERE s.ingested_at > now() - ($2 || ' days')::interval
                   AND s.text ILIKE '%' || e.name || '%'
              )`,
          [String(staleDays), String(referenceDays)],
        ),
      )

      const open = await store.reviewItems(workspaceId)
      const already = new Set(
        open
          .filter((item) => item.kind === 'stale')
          .map((item) => (item.subject as { entity?: { entityId?: string } }).entity?.entityId),
      )

      let proposed = 0
      for (const entity of stale) {
        if (already.has(entity.id)) continue
        await store.openReviewItem({
          workspaceId,
          kind: 'stale',
          subject: { entity: { entityId: entity.id, name: entity.name }, detector: 'stale' },
        })
        proposed += 1
      }
      return { proposed }
    },
  }
}
