/**
 * Fractional ordering keys (TASK-2).
 *
 * > Use fractional ordering keys rather than integer positions; integer
 * > positions require rewriting siblings on every move and produce exactly the
 * > concurrency bugs AC1 tests for.
 *
 * The bug that note points at is worth stating plainly. With integer
 * positions, moving one task renumbers every sibling after it, so two people
 * reordering at once each write a *complete* ordering computed from a state the
 * other has already changed. One write overwrites the other, and an item ends
 * up duplicated or gone.
 *
 * A fractional key makes a move a **single-row write** — the moved task and
 * nobody else. Two concurrent moves touch different rows, so both survive and
 * the result is a consistent order rather than one person's view of it.
 *
 * A `double` rather than a string: Postgres and JavaScript order doubles
 * identically, so the database sorts without anyone agreeing on a collation.
 * The cost is finite precision, which is handled explicitly below rather than
 * left to surprise somebody.
 */

/** The gap below which subdividing again stops being safe. */
export const ORDER_REBALANCE_THRESHOLD = 1e-9

/** The spacing new keys are given when there is nothing to sit between. */
const DEFAULT_STEP = 1024

/**
 * A key that sorts strictly between `before` and `after`.
 *
 * Either end may be absent, meaning "no neighbour that way" — appending to a
 * list must not require reading the list to find where it ends.
 */
export function keyBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return DEFAULT_STEP
  if (before === undefined) return after! - DEFAULT_STEP
  if (after === undefined) return before + DEFAULT_STEP

  // The midpoint, computed as `a + (b - a) / 2` rather than `(a + b) / 2`: the
  // latter overflows for large keys and, more importantly here, loses precision
  // for close ones — which is exactly the region this function is used in.
  return before + (after - before) / 2
}

/**
 * Whether the gap between two keys is too small to subdivide again.
 *
 * Doubles run out. The failure that matters is not that they run out, but that
 * they would do so *silently*: two tasks with the same key order arbitrarily,
 * and a list that was stable yesterday quietly stops being so. A caller checks
 * this and rebalances rather than discovering it from a support ticket.
 */
export function needsRebalance(before: number, after: number): boolean {
  return Math.abs(after - before) < ORDER_REBALANCE_THRESHOLD
}

/**
 * Evenly spaced keys for `count` siblings.
 *
 * Used when a gap has been subdivided to exhaustion. This is the one operation
 * that does rewrite every sibling — which is acceptable precisely because it is
 * rare, and it is rare because the gaps start at 1024 apart.
 */
export function rebalance(count: number): number[] {
  return Array.from({ length: count }, (_, index) => (index + 1) * DEFAULT_STEP)
}
