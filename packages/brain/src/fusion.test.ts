import { describe, it, expect } from 'vitest'
import { RRF_K, fuse } from './fusion.js'

/**
 * BRAIN-4 — reciprocal rank fusion, tie-breaking and truncation.
 *
 * The property that justifies RRF over score normalisation is the one in the
 * first test: agreement between two independent methods beats a high score from
 * one of them. Everything else here guards the ways a fusion silently stops
 * being reproducible — ties resolved by input order, or by insertion order in a
 * map — which would make a bundle impossible to compare against itself (AC4).
 */

const item = (id: string) => ({ id })

describe('BRAIN-4 rank fusion', () => {
  it('BRAIN-4: agreeing on a middling result beats one list loving it', () => {
    const fused = fuse({
      lexical: [item('a'), item('b'), item('shared')],
      vector: [item('c'), item('d'), item('shared')],
    })

    // `shared` is third in both and first in neither. Two independent methods
    // agreeing is stronger evidence than one method's top hit, and this is
    // exactly what "at least as good as the better of the two" (AC1) needs.
    expect(fused[0]!.item.id).toBe('shared')
    expect(fused[0]!.sources).toEqual(['lexical', 'vector'])
  })

  it('BRAIN-4: two deep appearances outweigh one first place — which is what k is for', () => {
    const tail = (prefix: string) => Array.from({ length: 50 }, (_, i) => item(`${prefix}${i}`))
    const fused = fuse({
      lexical: [item('top'), ...tail('x'), item('deep')],
      vector: [...tail('y'), item('deep')],
    })

    // Recorded because it surprises people, including whoever writes the next
    // change here. With k = 60 every rank past about 60 contributes roughly the
    // same, so two appearances at rank ~51 sum to more than one at rank 1. That
    // is inherent to RRF rather than a defect: presence in both lists is the
    // signal it is built to reward.
    expect(fused[0]!.item.id).toBe('deep')

    // The mitigation is not to fight the formula but to keep the lists short.
    // `retrieve` caps each search's candidates well below the depth at which
    // this bites, so a rank of 51 does not arise in practice; and lowering k
    // sharpens the top of each list if a corpus ever needs it.
    const sharper = fuse(
      {
        lexical: [item('top'), ...tail('x'), item('deep')],
        vector: [...tail('y'), item('deep')],
      },
      { k: 1 },
    )
    expect(sharper[0]!.item.id).toBe('top')
  })

  it('BRAIN-4: one empty list changes nothing about the other', () => {
    const only = [item('a'), item('b')]
    const fused = fuse({ lexical: only, vector: [] })

    // A half that found nothing must not reorder the half that did. This is the
    // ordinary case for a rare identifier, where the vector search is noise.
    expect(fused.map((f) => f.item.id)).toEqual(['a', 'b'])
  })

  it('BRAIN-4: no lists at all fuse to nothing', () => {
    expect(fuse({})).toEqual([])
    expect(fuse({ lexical: [], vector: [] })).toEqual([])
  })

  it('BRAIN-4: `limit` truncates after fusing, not before', () => {
    const fused = fuse(
      {
        lexical: [item('a'), item('b'), item('shared')],
        vector: [item('shared'), item('c')],
      },
      { limit: 2 },
    )

    // Truncating each list first would drop `shared` from the lexical side and
    // lose the agreement that makes it the best answer.
    expect(fused).toHaveLength(2)
    expect(fused[0]!.item.id).toBe('shared')
  })

  it('BRAIN-4: ties break the same way every time, whatever order the searches finished in', () => {
    const one = fuse({ lexical: [item('b')], vector: [item('a')] })
    const other = fuse({ vector: [item('a')], lexical: [item('b')] })

    // `a` and `b` are rank 1 in one list each, so their scores are identical.
    // A fusion that resolved that by insertion order would return a different
    // bundle depending on which query finished first — and a bundle that
    // cannot be reproduced cannot be evaluated.
    expect(one.map((f) => f.item.id)).toEqual(['a', 'b'])
    expect(other.map((f) => f.item.id)).toEqual(one.map((f) => f.item.id))
  })

  it('BRAIN-4: a tie between equal scores prefers the one more methods found', () => {
    const fused = fuse(
      {
        // `both` is rank 2 in two lists; `single` is rank 1 in one.
        lexical: [item('single'), item('both')],
        vector: [item('other'), item('both')],
      },
      { k: 1 },
    )

    expect(fused[0]!.item.id).toBe('both')
    expect(fused[0]!.sources).toHaveLength(2)
  })

  it('BRAIN-4: the smoothing constant is the documented one, and is adjustable', () => {
    // Named rather than inlined because it is the single number here anybody
    // would think to tune, and it should be tuned against the evaluation set.
    expect(RRF_K).toBe(60)

    const sharp = fuse({ a: [item('x'), item('y')] }, { k: 1 })
    const flat = fuse({ a: [item('x'), item('y')] }, { k: 1000 })

    // A small k separates the top of a list; a large one flattens it, which is
    // what makes agreement across lists dominate.
    const sharpGap = sharp[0]!.score - sharp[1]!.score
    const flatGap = flat[0]!.score - flat[1]!.score
    expect(sharpGap).toBeGreaterThan(flatGap)
  })

  it('BRAIN-4: a document appearing twice in one list is counted once per list', () => {
    // Duplicate ids reach here when two searches over different kinds return
    // the same chunk. Double-counting inside one list would let a repeated
    // result outrank a genuinely agreed one.
    const fused = fuse({ lexical: [item('a'), item('a'), item('b')] })

    expect(fused.map((f) => f.item.id)).toEqual(['a', 'b'])
    expect(fused[0]!.sources).toEqual(['lexical', 'lexical'])
  })
})
