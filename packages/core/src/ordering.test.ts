import { describe, it, expect } from 'vitest'
import { ORDER_REBALANCE_THRESHOLD, keyBetween, needsRebalance, rebalance } from './ordering.js'

/**
 * TASK-2 — fractional ordering keys.
 *
 * > Use fractional ordering keys rather than integer positions; integer
 * > positions require rewriting siblings on every move and produce exactly the
 * > concurrency bugs AC1 tests for.
 *
 * The bug that note is pointing at: with integer positions, moving one task
 * rewrites every sibling after it, so two people reordering at once each write
 * a full ordering computed from a state the other has already changed. One
 * overwrites the other and an item appears twice or not at all.
 *
 * A fractional key makes a move a **single-row write** — the moved task and
 * nobody else — so two concurrent moves touch different rows and both survive.
 * Everything below is about that property holding at the edges: adjacent keys,
 * repeated subdivision, and the point where precision runs out.
 */
describe('TASK-2 fractional ordering', () => {
  it('TASK-2: a key between two others sorts between them', () => {
    const middle = keyBetween(1, 2)
    expect(middle).toBeGreaterThan(1)
    expect(middle).toBeLessThan(2)
  })

  it('TASK-2: appending to the end needs no neighbour on the right', () => {
    // The ordinary case — adding a task to a list. It must not require reading
    // the whole list to find out where the end is.
    expect(keyBetween(5, undefined)).toBeGreaterThan(5)
  })

  it('TASK-2: prepending to the start needs no neighbour on the left', () => {
    expect(keyBetween(undefined, 5)).toBeLessThan(5)
  })

  it('TASK-2: the first key in an empty list is a number, not a special case', () => {
    // A list with nothing in it is the state every list starts in, and a
    // caller should not have to branch on it.
    expect(Number.isFinite(keyBetween(undefined, undefined))).toBe(true)
  })

  it('TASK-2: a move is one write, so repeated insertion between the same pair keeps working', () => {
    // Dragging into the same gap over and over is what a person reviewing a
    // proposed tree actually does. Each insertion subdivides; none of them may
    // collide with a neighbour.
    let left = 1
    const right = 2
    const keys: number[] = []

    for (let i = 0; i < 30; i += 1) {
      const key = keyBetween(left, right)
      expect(key, `collision after ${i} insertions`).toBeGreaterThan(left)
      expect(key).toBeLessThan(right)
      keys.push(key)
      left = key
    }

    // Strictly increasing, which is the whole contract.
    expect([...keys].sort((a, b) => a - b)).toEqual(keys)
  })

  it('TASK-2: subdividing far enough is detected rather than silently collapsing', () => {
    // Doubles run out. The failure that matters is not that it happens, but
    // that it happens *silently* — two tasks with the same key order
    // arbitrarily, and the list quietly stops being stable.
    let left = 1
    const right = 1 + Number.EPSILON * 4

    let exhausted = false
    for (let i = 0; i < 10; i += 1) {
      const key = keyBetween(left, right)
      if (needsRebalance(left, right)) {
        exhausted = true
        break
      }
      left = key
    }

    expect(exhausted, 'running out of precision must be detectable').toBe(true)
  })

  it('TASK-2: rebalancing spreads keys evenly and preserves the order', () => {
    const crowded = [1, 1.0000001, 1.0000002, 5]
    const spread = rebalance(crowded.length)

    expect(spread).toHaveLength(4)
    // Order preserved, gaps restored — the point of rebalancing is that the
    // next insertion has room again.
    expect([...spread].sort((a, b) => a - b)).toEqual(spread)
    for (let i = 1; i < spread.length; i += 1) {
      expect(needsRebalance(spread[i - 1]!, spread[i]!)).toBe(false)
    }
  })

  it('TASK-2: a gap with room to spare does not ask to be rebalanced', () => {
    // Otherwise every move would trigger a full rewrite of the siblings, which
    // is the integer-position behaviour this scheme exists to avoid.
    expect(needsRebalance(1, 2)).toBe(false)
    expect(needsRebalance(1, 1 + ORDER_REBALANCE_THRESHOLD * 10)).toBe(false)
  })

  it('TASK-2: two people inserting into different gaps never produce the same key', () => {
    // The concurrency property in miniature: separate gaps are separate
    // arithmetic, so there is no shared counter for two writers to race over.
    const a = keyBetween(1, 2)
    const b = keyBetween(3, 4)
    expect(a).not.toBe(b)
  })

  it('TASK-2: keys are ordinary numbers, so the database sorts them without help', () => {
    // A string-based scheme would need a collation everyone agrees on; a
    // double is ordered identically in Postgres and in JavaScript.
    expect(typeof keyBetween(1, 2)).toBe('number')
  })
})
