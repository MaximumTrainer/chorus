import type { ParsedSymbol } from './parse.js'

/**
 * Chunking (BRAIN-2).
 *
 * Retrieval quality depends more on this than on the embedding model, which is
 * why it is a pure function with the most careful tests in the package. Three
 * properties, pulling against each other:
 *
 *  - **Aligned.** A chunk is a whole thought — a function, not its middle eleven
 *    lines — because a hit that starts mid-body is one a reader cannot act on.
 *  - **Bounded.** An embedding of a 2,000-line file is an average of everything
 *    in it and therefore about nothing.
 *  - **Overlapping.** Something written across a boundary stays findable from
 *    either side.
 */

/**
 * Roughly 80 lines of code, which is a large function and a small file.
 *
 * Chosen in lines rather than tokens because the alignment it protects is a
 * line-based idea, and because a chunk's line range is what a citation shows.
 */
export const MAX_CHUNK_LINES = 80

/** Enough to carry a signature and its first statements across a split. */
export const OVERLAP_LINES = 10

/** Below this, splitting produces fragments too small to mean anything. */
const MIN_TAIL_LINES = 3

export interface Chunk {
  /** 1-based, inclusive. What a citation shows, so it must match `text`. */
  readonly lineStart: number
  readonly lineEnd: number
  readonly text: string
  /** The symbol this chunk covers, or null for a windowed one. */
  readonly symbolName: string | null
  readonly symbolKind: string | null
}

function slice(lines: readonly string[], start: number, end: number, symbol: ParsedSymbol | null): Chunk {
  return {
    lineStart: start,
    lineEnd: end,
    text: lines.slice(start - 1, end).join('\n'),
    symbolName: symbol?.name ?? null,
    symbolKind: symbol?.kind ?? null,
  }
}

/**
 * Splits a range into windows of at most `MAX_CHUNK_LINES`, overlapping.
 *
 * A trailing sliver is folded into the previous window rather than emitted:
 * three lines on their own embed to noise, and the overlap already covers them.
 */
function windows(
  lines: readonly string[],
  start: number,
  end: number,
  symbol: ParsedSymbol | null,
): Chunk[] {
  if (end - start + 1 <= MAX_CHUNK_LINES) return [slice(lines, start, end, symbol)]

  const chunks: Chunk[] = []
  let cursor = start
  while (cursor <= end) {
    const stop = Math.min(cursor + MAX_CHUNK_LINES - 1, end)
    chunks.push(slice(lines, cursor, stop, symbol))
    if (stop === end) break

    const next = stop - OVERLAP_LINES + 1
    // Fold a sliver into what we just emitted rather than emitting it alone.
    if (end - next + 1 < MIN_TAIL_LINES) break
    cursor = next
  }
  return chunks
}

/**
 * Chunks one file.
 *
 * `symbols` may be empty — an unsupported language, or a parse that failed —
 * in which case the whole file is windowed. That is the honest degradation: the
 * file stays retrievable, and no structure is claimed for it.
 */
export function chunkFile(source: string, symbols: readonly ParsedSymbol[]): Chunk[] {
  if (source.trim() === '') return []

  const lines = source.split('\n')
  const total = lines.length

  // Nested symbols are dropped: a class and its methods both parse, and
  // chunking both stores every method body twice — which lets one file dominate
  // retrieval simply by being well structured.
  const outermost = [...symbols]
    .filter((symbol) => symbol.lineStart >= 1 && symbol.lineEnd <= total)
    .sort((a, b) => a.lineStart - b.lineStart || b.lineEnd - a.lineEnd)
    .filter((symbol, index, all) =>
      all.every(
        (other, otherIndex) =>
          otherIndex === index ||
          !(other.lineStart <= symbol.lineStart && other.lineEnd >= symbol.lineEnd && otherIndex < index),
      ),
    )

  const chunks: Chunk[] = []
  let cursor = 1

  for (const symbol of outermost) {
    if (symbol.lineStart < cursor) continue

    // The gap before this symbol — imports, constants, top-level statements.
    // These are where a repository's conventions live, so dropping them because
    // no symbol claimed them makes the most useful lines the unfindable ones.
    if (symbol.lineStart > cursor) {
      chunks.push(...windows(lines, cursor, symbol.lineStart - 1, null))
    }

    chunks.push(...windows(lines, symbol.lineStart, symbol.lineEnd, symbol))
    cursor = symbol.lineEnd + 1
  }

  if (cursor <= total) chunks.push(...windows(lines, cursor, total, null))

  // A gap of blank lines between symbols embeds to nothing useful.
  return chunks.filter((chunk) => chunk.text.trim() !== '')
}
