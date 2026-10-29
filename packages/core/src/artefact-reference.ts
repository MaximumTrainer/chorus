/**
 * Resolving a natural-language artefact reference (CHAT-6).
 *
 * "add criteria to CH-12", "condense the Onboarding spec", "tidy up the spec" —
 * the agent has to turn a phrase into the artefact it names, and the one thing
 * it must not do is guess when the phrase fits more than one. So this ranks the
 * candidates and reports ambiguity rather than picking (AC4); the caller then
 * asks, through the CHAT-4 clarify path.
 *
 * Pure and candidate-driven: the caller supplies the artefacts the acting user
 * can see, so resolution never reaches past what they are allowed to (AC5 is
 * the permission on the *edit*, but a reference should not even resolve to a
 * thing they cannot see). The ranking is deliberately simple — a key hit, else
 * title-word overlap with a boost for an exact title — because a cleverer
 * scorer that resolves "the spec" to one of two specs is precisely the
 * confident wrong answer this exists to avoid.
 */

export interface ArtefactCandidate {
  readonly kind: 'task' | 'document'
  readonly id: string
  /** A task's key (CH-12); null for a document. */
  readonly key: string | null
  readonly title: string
}

export type ReferenceResolution =
  | { readonly status: 'resolved'; readonly match: ArtefactCandidate }
  | { readonly status: 'ambiguous'; readonly candidates: readonly ArtefactCandidate[] }
  | { readonly status: 'none' }

/** Lower-case, alphanumerics only — so "CH-12", "ch12" and "CH 12" are one token. */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** Words that carry no signal about which artefact is meant. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'and', 'for', 'in', 'on', 'this', 'that', 'it',
  'add', 'update', 'change', 'edit', 'refine', 'condense', 'tidy', 'up', 'open', 'write',
])

function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
}

/** Lower-case, non-alphanumerics to single spaces — keeping word boundaries. */
function spaced(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `
}

/** The key-shaped tokens in the text ("CH-12", "ch12"), squashed for comparison. */
function keyTokens(text: string): Set<string> {
  return new Set((text.match(/[a-z][a-z0-9]*-?\d+/gi) ?? []).map(squash))
}

export function resolveArtefactReference(
  text: string,
  candidates: readonly ArtefactCandidate[],
): ReferenceResolution {
  // A key hit is decisive: a key is an identity, and if the text contains one,
  // that is the artefact, whatever its title overlaps with.
  const keys = keyTokens(text)
  const byKey = candidates.filter((c) => c.key !== null && keys.has(squash(c.key)))
  if (byKey.length === 1) return { status: 'resolved', match: byKey[0]! }
  if (byKey.length > 1) return { status: 'ambiguous', candidates: byKey }

  // No key. Score each candidate by how much of its title the text names, with
  // a boost when the whole title appears — so "Billing" picks the document
  // called exactly "Billing" over the one called "Billing spec".
  const haystack = spaced(text)
  const textWords = new Set(words(text))
  const scored = candidates
    .map((candidate) => {
      const titleWords = words(candidate.title).filter((word) => !STOPWORDS.has(word))
      const overlap = titleWords.filter((word) => textWords.has(word)).length
      const whole = haystack.includes(spaced(candidate.title)) ? 1 : 0
      return { candidate, score: overlap + whole * 10 }
    })
    .filter((entry) => entry.score > 0)

  if (scored.length === 0) return { status: 'none' }

  const best = Math.max(...scored.map((entry) => entry.score))
  const winners = scored.filter((entry) => entry.score === best).map((entry) => entry.candidate)
  return winners.length === 1
    ? { status: 'resolved', match: winners[0]! }
    : { status: 'ambiguous', candidates: winners }
}
