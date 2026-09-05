/**
 * Anchoring a comment to a phrase (DOC-4).
 *
 * > Anchors that drift or vanish under concurrent editing destroy the review,
 * > and a lost comment is worse than no comment because someone believed it was
 * > delivered.
 *
 * An anchor is the **quoted text**, not a position. A position has to be
 * rebased against every edit anybody makes anywhere before it, and gets that
 * wrong silently; a quotation is located afresh each time it is read, so an
 * edit somewhere else in the document cannot move it at all. What that costs is
 * the case where the same words appear twice, which is what `prefix` is for.
 *
 * The quotation is kept whatever happens, because it is the only way to render
 * an orphan usefully: "this comment was about *this sentence*, which is gone"
 * is something a reader can act on, and a comment with no context is not.
 */

export interface Anchor {
  /** The exact text the comment is about. */
  readonly quote: string
  /**
   * Enough of what came before to tell two identical quotations apart.
   *
   * Optional because most quotations are unique, and demanding context for all
   * of them would make every anchor fragile to an edit *before* the phrase —
   * which is exactly what anchoring by text is meant to survive.
   */
  readonly prefix?: string
}

export type AnchorLocation =
  | { readonly found: true; readonly from: number; readonly to: number }
  /** The text is gone: the comment is an orphan and must be shown as one. */
  | { readonly found: false; readonly reason: 'missing' }
  /** The text appears more than once and nothing distinguishes them. */
  | { readonly found: false; readonly reason: 'ambiguous' }

function occurrencesOf(haystack: string, needle: string): number[] {
  if (needle === '') return []
  const found: number[] = []
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    found.push(at)
    // Advanced by one, not by the needle's length: "aa" occurs twice in "aaa",
    // and collapsing that to once would anchor a comment to a phrase the
    // reader did not choose.
    at = haystack.indexOf(needle, at + 1)
  }
  return found
}

/** Where an anchor points now, if anywhere. */
export function locateAnchor(text: string, anchor: Anchor): AnchorLocation {
  const at = occurrencesOf(text, anchor.quote)
  if (at.length === 0) return { found: false, reason: 'missing' }
  if (at.length === 1) return { found: true, from: at[0]!, to: at[0]! + anchor.quote.length }

  const prefix = anchor.prefix ?? ''
  if (prefix === '') return { found: false, reason: 'ambiguous' }

  // The occurrence actually preceded by the recorded context. Compared against
  // the text immediately before each candidate rather than searched for
  // separately, so a prefix that also appears elsewhere cannot pick a match it
  // does not precede.
  const matching = at.filter((index) => text.slice(0, index).endsWith(prefix))
  if (matching.length === 1) {
    return { found: true, from: matching[0]!, to: matching[0]! + anchor.quote.length }
  }

  return { found: false, reason: 'ambiguous' }
}
