/**
 * Reciprocal rank fusion (BRAIN-4, architecture.md §10.5).
 *
 * Two searches answer the same question in incomparable units: a `ts_rank` and
 * a cosine distance have no common scale, and normalising them invents one —
 * a normalisation that is wrong in a way nobody can see, because both halves
 * still produce plausible orderings.
 *
 * RRF sidesteps that entirely by discarding the scores and keeping only the
 * *ranks*. A document scores `1 / (k + rank)` in each list it appears in, and
 * those add. Its whole appeal is that it needs no tuning per corpus and no
 * comparability between the things it combines, which is exactly the situation
 * here and will stay so as more kinds are added.
 *
 * The consequence worth understanding: a document ranked well by both halves
 * beats one ranked brilliantly by one of them. That is the intended behaviour —
 * agreement between two independent methods is stronger evidence than a high
 * score from either — and it is what AC1's "at least as good as the better of
 * the two" is actually asking for.
 */

export interface RankedItem {
  readonly id: string
}

/**
 * The rank-smoothing constant.
 *
 * 60 is the value from the original TREC work and the one every implementation
 * uses; it is here as a named constant rather than a literal because it is the
 * single number in this file anybody would think to tune, and it should be
 * tuned against the evaluation set rather than guessed at.
 *
 * Its effect: large k flattens the difference between rank 1 and rank 10, so
 * appearing in *both* lists matters more; small k makes the top of each list
 * dominate.
 */
export const RRF_K = 60

export interface FusedItem<T extends RankedItem> {
  readonly item: T
  readonly score: number
  /** Which input lists it appeared in, for explaining a result. */
  readonly sources: readonly string[]
}

/**
 * Fuses ranked lists into one.
 *
 * Ties are broken by the number of lists an item appeared in, then by its id —
 * deterministically, and not by input order. A fusion whose output depended on
 * which search returned first would make retrieval non-reproducible, and a
 * bundle that cannot be reproduced cannot be evaluated (AC4).
 */
export function fuse<T extends RankedItem>(
  lists: Readonly<Record<string, readonly T[]>>,
  options: { k?: number; limit?: number } = {},
): FusedItem<T>[] {
  const k = options.k ?? RRF_K
  const scores = new Map<string, { item: T; score: number; sources: string[] }>()

  for (const [source, items] of Object.entries(lists)) {
    for (const [index, item] of items.entries()) {
      // Rank is 1-based: the top result of each list contributes `1/(k+1)`.
      const contribution = 1 / (k + index + 1)
      const existing = scores.get(item.id)
      if (existing) {
        existing.score += contribution
        existing.sources.push(source)
      } else {
        scores.set(item.id, { item, score: contribution, sources: [source] })
      }
    }
  }

  return [...scores.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      // Agreement between methods breaks a tie before anything arbitrary does.
      if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length
      return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0
    })
    .slice(0, options.limit ?? Number.POSITIVE_INFINITY)
    .map(({ item, score, sources }) => ({ item, score, sources: [...sources].sort() }))
}
