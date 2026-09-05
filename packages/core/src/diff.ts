/**
 * Block-level diff between two renderings of a document (DOC-5 AC2).
 *
 * Rendered Markdown rather than the CRDT's operation log, per the requirement's
 * implementation note: an operation log is a faithful record of how a document
 * got here and is unreadable as an answer to "what changed". Blocks rather than
 * characters, because a paragraph rewritten word by word produces a diff nobody
 * reads, and the unit somebody reviews is the paragraph.
 */

export const DIFF_KINDS = ['unchanged', 'added', 'removed', 'moved'] as const
export type DiffKind = (typeof DIFF_KINDS)[number]

export interface DiffLine {
  readonly kind: DiffKind
  readonly text: string
}

/**
 * Splits a rendering into the blocks a reader sees.
 *
 * A blank line separates blocks in Markdown, and inside a list or a table each
 * line is its own row — so those are split per line. Treating a whole table as
 * one block would report a single changed cell as the entire table being
 * replaced, which is the case AC2 names.
 */
export function blocksOf(markdown: string): string[] {
  const blocks: string[] = []

  for (const paragraph of markdown.split(/\n{2,}/)) {
    const trimmed = paragraph.trim()
    if (trimmed === '') continue

    const structured = /^\s*(?:[-*+]\s|\d+\.\s|\|)/m.test(trimmed)
    if (structured) {
      for (const line of trimmed.split('\n')) {
        if (line.trim() !== '') blocks.push(line.trimEnd())
      }
      continue
    }
    blocks.push(trimmed)
  }

  return blocks
}

/** The longest common subsequence of two block lists, as index pairs. */
function commonBlocks(before: readonly string[], after: readonly string[]): Array<[number, number]> {
  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  )

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        before[i] === after[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }

  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (table[i + 1]![j]! > table[i]![j + 1]!) {
      i += 1
    } else {
      // On a tie, advance through the *new* document rather than the old one.
      // Both alignments are the same length, but this one keeps a block that
      // stayed put reported as unchanged and lets the block that moved be the
      // one reported as moved — which is what happened, and the reverse tie
      // reads as though the paragraph that never moved was the one that did.
      j += 1
    }
  }
  return pairs
}

/**
 * What changed between two renderings.
 *
 * A block that left one place and appeared in another is reported as `moved`
 * once, not as a deletion plus an insertion. Reordering a document would
 * otherwise produce a diff where every real change is buried among imaginary
 * ones — and reordering is most of what editing a specification is.
 */
export function diffBlocks(before: string, after: string): DiffLine[] {
  const from = blocksOf(before)
  const to = blocksOf(after)

  const kept = commonBlocks(from, to)
  const keptFrom = new Set(kept.map(([i]) => i))
  const keptTo = new Set(kept.map(([, j]) => j))

  const removed = from.map((text, i) => ({ text, i })).filter(({ i }) => !keptFrom.has(i))
  const added = to.map((text, j) => ({ text, j })).filter(({ j }) => !keptTo.has(j))

  // Paired by content: a block that vanished from one place and appeared in
  // another is the same block.
  const movedText = new Set<string>()
  const availableRemoved = new Map<string, number>()
  for (const entry of removed) {
    availableRemoved.set(entry.text, (availableRemoved.get(entry.text) ?? 0) + 1)
  }
  for (const entry of added) {
    const seen = availableRemoved.get(entry.text) ?? 0
    if (seen > 0) {
      availableRemoved.set(entry.text, seen - 1)
      movedText.add(entry.text)
    }
  }

  const lines: DiffLine[] = []
  let i = 0
  let j = 0

  const emitRemoved = (text: string) => {
    // A moved block is reported once, at its destination. Reporting it at both
    // ends would say two things happened where one did.
    if (!movedText.has(text)) lines.push({ kind: 'removed', text })
  }

  for (const [nextFrom, nextTo] of kept) {
    while (i < nextFrom) emitRemoved(from[i++]!)
    while (j < nextTo) {
      const text = to[j++]!
      lines.push({ kind: movedText.has(text) ? 'moved' : 'added', text })
    }
    lines.push({ kind: 'unchanged', text: from[nextFrom]! })
    i = nextFrom + 1
    j = nextTo + 1
  }

  while (i < from.length) emitRemoved(from[i++]!)
  while (j < to.length) {
    const text = to[j++]!
    lines.push({ kind: movedText.has(text) ? 'moved' : 'added', text })
  }

  return lines
}
