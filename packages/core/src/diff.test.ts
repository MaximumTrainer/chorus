import { describe, it, expect } from 'vitest'
import { blocksOf, diffBlocks, type DiffLine } from './diff.js'

/**
 * DOC-5 AC2 — insert, delete, move, and nested structures.
 *
 * The move case is the one that earns this its own module. A diff that reports
 * a reordered paragraph as a deletion plus an insertion buries the one real
 * change among two imaginary ones, and reordering is most of what editing a
 * specification consists of.
 */
describe('DOC-5 block diff', () => {
  const kindOf = (diff: DiffLine[], text: string) =>
    diff.find((line) => line.text === text)?.kind

  it('DOC-5: identical documents differ in nothing', () => {
    const diff = diffBlocks('Alpha.\n\nBravo.', 'Alpha.\n\nBravo.')
    expect(diff.every((line) => line.kind === 'unchanged')).toBe(true)
  })

  it('DOC-5: an inserted block is added, and its neighbours are untouched', () => {
    const diff = diffBlocks('Alpha.\n\nBravo.', 'Alpha.\n\nNew.\n\nBravo.')
    expect(kindOf(diff, 'New.')).toBe('added')
    expect(kindOf(diff, 'Alpha.')).toBe('unchanged')
    expect(kindOf(diff, 'Bravo.')).toBe('unchanged')
  })

  it('DOC-5: a deleted block is removed', () => {
    const diff = diffBlocks('Alpha.\n\nBravo.\n\nCharlie.', 'Alpha.\n\nCharlie.')
    expect(kindOf(diff, 'Bravo.')).toBe('removed')
  })

  it('DOC-5: a reordered block is a move, reported once', () => {
    const diff = diffBlocks('Alpha.\n\nBravo.\n\nCharlie.', 'Charlie.\n\nAlpha.\n\nBravo.')
    expect(kindOf(diff, 'Charlie.')).toBe('moved')
    // Once. Reported at both ends it would say two things happened where one
    // did, which is the shape of diff people learn to skim past.
    expect(diff.filter((line) => line.text === 'Charlie.')).toHaveLength(1)
  })

  it('DOC-5: an insertion, a deletion and a move are all reported together', () => {
    const diff = diffBlocks('Alpha.\n\nBravo.\n\nCharlie.', 'Charlie.\n\nAlpha.\n\nDelta.')
    expect(kindOf(diff, 'Bravo.')).toBe('removed')
    expect(kindOf(diff, 'Delta.')).toBe('added')
    expect(kindOf(diff, 'Charlie.')).toBe('moved')
    expect(kindOf(diff, 'Alpha.')).toBe('unchanged')
  })

  it('DOC-5: a list is compared row by row, not as one lump', () => {
    const diff = diffBlocks('- one\n- two\n- three', '- one\n- three')
    // Whole-block comparison would report the entire list replaced, which
    // tells a reviewer nothing about what actually changed.
    expect(kindOf(diff, '- two')).toBe('removed')
    expect(kindOf(diff, '- one')).toBe('unchanged')
  })

  it('DOC-5: a table is compared row by row', () => {
    const before = '| Header |\n| --- |\n| Kept |\n| Gone |'
    const after = '| Header |\n| --- |\n| Kept |\n| New |'
    const diff = diffBlocks(before, after)
    expect(kindOf(diff, '| Gone |')).toBe('removed')
    expect(kindOf(diff, '| New |')).toBe('added')
    expect(kindOf(diff, '| Kept |')).toBe('unchanged')
  })

  it('DOC-5: blank space between blocks is not a change', () => {
    // Otherwise every save reformats and every diff is noise.
    const diff = diffBlocks('Alpha.\n\nBravo.', 'Alpha.\n\n\n\nBravo.\n')
    expect(diff.every((line) => line.kind === 'unchanged')).toBe(true)
  })

  it('DOC-5: an empty document against a written one is all additions', () => {
    const diff = diffBlocks('', 'Alpha.\n\nBravo.')
    expect(diff.map((line) => line.kind)).toEqual(['added', 'added'])
  })

  it('DOC-5: two identical blocks moving together are both accounted for', () => {
    // Content-paired move detection has to count, not just check membership,
    // or one of a duplicate pair is reported as a move and the other vanishes.
    const diff = diffBlocks('X.\n\nX.\n\nY.', 'Y.\n\nX.\n\nX.')
    expect(diff.filter((line) => line.text === 'X.')).toHaveLength(2)
  })

  it('DOC-5: blocksOf keeps headings as their own blocks', () => {
    expect(blocksOf('# Title\n\n## Section\n\nText.')).toEqual(['# Title', '## Section', 'Text.'])
  })
})
