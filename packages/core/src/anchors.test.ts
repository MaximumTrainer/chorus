import { describe, it, expect } from 'vitest'
import { locateAnchor } from './anchors.js'

/**
 * DOC-4 — anchor rebasing across insert, delete and replace.
 *
 * The requirement asks for these to be tested exhaustively rather than
 * discovered in production, and they are cheap to test because locating a
 * quotation is pure. The property that makes anchoring by text worth having is
 * in the first few cases: an edit *elsewhere* cannot move the anchor at all,
 * because there is no position to rebase.
 */
describe('DOC-4 anchor location', () => {
  const anchor = { quote: 'Part-payments are the hard case.' }
  const original = 'Finance reconciles by hand. Part-payments are the hard case. It costs a day.'

  it('DOC-4: an anchor points at its phrase in unchanged text', () => {
    expect(locateAnchor(original, anchor)).toEqual({
      found: true,
      from: original.indexOf(anchor.quote),
      to: original.indexOf(anchor.quote) + anchor.quote.length,
    })
  })

  it('DOC-4: an insertion before the phrase moves it, and the anchor follows', () => {
    const edited = `Every week. ${original}`
    const found = locateAnchor(edited, anchor)
    expect(found.found && found.from).toBe(edited.indexOf(anchor.quote))
  })

  it('DOC-4: an insertion after the phrase leaves it exactly where it was', () => {
    const found = locateAnchor(`${original} Sometimes two.`, anchor)
    expect(found.found && found.from).toBe(original.indexOf(anchor.quote))
  })

  it('DOC-4: a deletion elsewhere does not disturb it', () => {
    const edited = original.replace('Finance reconciles by hand. ', '')
    const found = locateAnchor(edited, anchor)
    expect(found.found && found.from).toBe(0)
  })

  it('DOC-4: a replacement around it does not disturb it', () => {
    const edited = original
      .replace('Finance reconciles by hand.', 'Reconciliation is manual.')
      .replace('It costs a day.', 'It costs two days.')
    expect(locateAnchor(edited, anchor).found).toBe(true)
  })

  it('DOC-4: deleting the phrase orphans the anchor rather than moving it', () => {
    const edited = original.replace('Part-payments are the hard case. ', '')
    expect(locateAnchor(edited, anchor)).toEqual({ found: false, reason: 'missing' })
  })

  it('DOC-4: editing inside the phrase orphans it', () => {
    // Correct, and worth stating: the comment was about the sentence as it
    // was, and the sentence is not that any more. Silently re-pointing it at
    // the rewritten version would attribute an objection to text its author
    // never read.
    const edited = original.replace('the hard case', 'the interesting case')
    expect(locateAnchor(edited, anchor)).toEqual({ found: false, reason: 'missing' })
  })

  it('DOC-4: a phrase appearing twice is ambiguous without context', () => {
    const twice = 'Split the payment. Then split the payment again.'
    expect(locateAnchor(twice, { quote: 'the payment' })).toEqual({
      found: false,
      reason: 'ambiguous',
    })
  })

  it('DOC-4: context picks the occurrence it precedes', () => {
    const twice = 'Split the payment. Then split the payment again.'
    const found = locateAnchor(twice, { quote: 'the payment', prefix: 'Then split ' })
    expect(found.found && found.from).toBe(twice.lastIndexOf('the payment'))
  })

  it('DOC-4: context that fits neither occurrence leaves it ambiguous', () => {
    const twice = 'Split the payment. Then split the payment again.'
    expect(locateAnchor(twice, { quote: 'the payment', prefix: 'Never ' })).toEqual({
      found: false,
      reason: 'ambiguous',
    })
  })

  it('DOC-4: overlapping occurrences are counted, not collapsed', () => {
    expect(locateAnchor('aaa', { quote: 'aa' })).toEqual({ found: false, reason: 'ambiguous' })
  })

  it('DOC-4: an empty quotation anchors nothing', () => {
    // `indexOf('')` is 0 for every string, so an unguarded implementation
    // anchors an empty comment to the start of every document.
    expect(locateAnchor('anything', { quote: '' })).toEqual({ found: false, reason: 'missing' })
  })
})
