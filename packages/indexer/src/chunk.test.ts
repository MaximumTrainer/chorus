import { describe, it, expect } from 'vitest'
import { chunkFile, MAX_CHUNK_LINES, OVERLAP_LINES } from './chunk.js'
import type { ParsedSymbol } from './parse.js'

/**
 * BRAIN-2 — chunking.
 *
 * The issue's own note says retrieval quality depends more on chunking than on
 * the embedding model, which is why this is the most carefully tested pure
 * function in the indexer. Three properties matter, and they pull against each
 * other:
 *
 *  - **Aligned**, so a chunk is a whole thought — a function, not its middle
 *    eleven lines. A retrieval hit that starts mid-body is one a reader cannot
 *    act on.
 *  - **Bounded**, because an embedding of a 2,000-line file is an average of
 *    everything in it and therefore about nothing.
 *  - **Overlapping**, so something written across a boundary is still findable
 *    from either side.
 */

const lines = (count: number, prefix = 'line'): string =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n')

const symbol = (name: string, start: number, end: number): ParsedSymbol => ({
  kind: 'function',
  name,
  lineStart: start,
  lineEnd: end,
  signature: `function ${name}()`,
})

describe('BRAIN-2 chunking', () => {
  it('BRAIN-2: a chunk covers a whole symbol when the parse succeeded', () => {
    const source = lines(30)
    const chunks = chunkFile(source, [symbol('alpha', 1, 10), symbol('beta', 12, 25)])

    const alpha = chunks.find((chunk) => chunk.symbolName === 'alpha')!
    expect(alpha.lineStart).toBe(1)
    expect(alpha.lineEnd).toBe(10)
    expect(alpha.text.split('\n')).toHaveLength(10)
  })

  it('BRAIN-2: every line of the file is covered by some chunk', () => {
    // Gaps between symbols — imports, constants, top-level statements — are
    // where a repository's conventions actually live. Dropping them because no
    // symbol claimed them makes the most useful lines the unfindable ones.
    const source = lines(40)
    const chunks = chunkFile(source, [symbol('alpha', 10, 20), symbol('beta', 30, 35)])

    const covered = new Set<number>()
    for (const chunk of chunks) {
      for (let line = chunk.lineStart; line <= chunk.lineEnd; line++) covered.add(line)
    }
    for (let line = 1; line <= 40; line++) {
      expect(covered.has(line), `line ${line} is in no chunk`).toBe(true)
    }
  })

  it('BRAIN-2: a symbol longer than the cap is split, with overlap between the parts', () => {
    const source = lines(MAX_CHUNK_LINES * 2 + 20)
    const chunks = chunkFile(source, [symbol('huge', 1, MAX_CHUNK_LINES * 2 + 20)])

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.lineEnd - chunk.lineStart + 1).toBeLessThanOrEqual(MAX_CHUNK_LINES)
    }

    // Consecutive parts share lines, so a fact stated across the split is
    // findable from either side.
    const [first, second] = chunks
    expect(second!.lineStart).toBeLessThanOrEqual(first!.lineEnd)
    expect(first!.lineEnd - second!.lineStart + 1).toBe(OVERLAP_LINES)
  })

  it('BRAIN-2: chunks never exceed the cap, whatever the symbols say', () => {
    const source = lines(500)
    const chunks = chunkFile(source, [symbol('a', 1, 400), symbol('b', 401, 500)])

    for (const chunk of chunks) {
      expect(chunk.lineEnd - chunk.lineStart + 1).toBeLessThanOrEqual(MAX_CHUNK_LINES)
    }
  })

  it('BRAIN-2: a file with no symbols falls back to windowed chunking', () => {
    // A parse failure or an unsupported language must still yield a retrievable
    // file. Refusing to chunk it would make "we do not have a grammar for this"
    // indistinguishable from "this file does not exist".
    const source = lines(MAX_CHUNK_LINES + 30)
    const chunks = chunkFile(source, [])

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]!.symbolName).toBeNull()
    expect(chunks.at(-1)!.lineEnd).toBe(MAX_CHUNK_LINES + 30)
  })

  it('BRAIN-2: a short file is one chunk, not many tiny ones', () => {
    const chunks = chunkFile(lines(12), [])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ lineStart: 1, lineEnd: 12 })
  })

  it('BRAIN-2: an empty file yields no chunks rather than one empty chunk', () => {
    // An embedding of "" is a vector that matches everything weakly, which is
    // worse than no vector at all.
    expect(chunkFile('', [])).toHaveLength(0)
    expect(chunkFile('   \n\n  \n', [])).toHaveLength(0)
  })

  it('BRAIN-2: chunk text matches the lines it claims', () => {
    const source = lines(50)
    for (const chunk of chunkFile(source, [symbol('alpha', 5, 15)])) {
      const expected = source
        .split('\n')
        .slice(chunk.lineStart - 1, chunk.lineEnd)
        .join('\n')
      // A chunk whose text and line range disagree produces a citation that
      // points somewhere the reader will not find what they were shown.
      expect(chunk.text).toBe(expected)
    }
  })

  it('BRAIN-2: nested symbols do not produce duplicate overlapping chunks', () => {
    // A class and its methods both parse as symbols. Emitting a chunk for each
    // would store the method bodies twice and let one file dominate retrieval.
    const source = lines(40)
    const chunks = chunkFile(source, [
      { kind: 'class', name: 'Store', lineStart: 1, lineEnd: 30, signature: 'class Store' },
      symbol('add', 5, 12),
      symbol('remove', 14, 22),
    ])

    const names = chunks.map((chunk) => chunk.symbolName)
    expect(names).toContain('Store')
    expect(names, 'a method inside a chunked class must not be chunked again').not.toContain('add')
  })

  it('BRAIN-2: chunking is deterministic', () => {
    // Re-indexing an unchanged file must produce identical chunks, or every
    // re-index re-embeds everything and the cache never hits.
    const source = lines(120)
    const symbols = [symbol('alpha', 1, 40), symbol('beta', 45, 100)]
    expect(chunkFile(source, symbols)).toEqual(chunkFile(source, symbols))
  })
})
