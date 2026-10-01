import { describe, it, expect } from 'vitest'
import { ValidationError } from './errors.js'
import { decodeCursor, encodeCursor, pageOf, truncated } from './mcp-results.js'

/**
 * MCP-2 AC2 — results are bounded.
 *
 * An unbounded list or document dumped into an agent's context wastes tokens
 * and can crowd out the task itself (#86). These are the two ways a result is
 * kept within the limit: a list is paged, and anything still too long is cut
 * with a way to read on.
 */

const rows = (count: number, width = 10) =>
  Array.from({ length: count }, (_, i) => ({ id: `row-${i}`, text: 'x'.repeat(width) }))

describe('MCP-2 bounded results', () => {
  it('MCP-2: a cursor round-trips, and one that was not issued is refused', () => {
    expect(decodeCursor(encodeCursor(40))).toBe(40)
    expect(() => decodeCursor('not-a-cursor')).toThrow(ValidationError)
    expect(() => decodeCursor(encodeCursor(-1))).toThrow(ValidationError)
  })

  it('MCP-2: a page holds at most `limit` items and says where the next one starts', () => {
    const page = pageOf(rows(10), { offset: 0, limit: 4, maxChars: 10_000 })

    expect(page.items.map((row) => row.id)).toEqual(['row-0', 'row-1', 'row-2', 'row-3'])
    expect(decodeCursor(page.nextCursor!)).toBe(4)
  })

  it('MCP-2: a page is shortened to fit the size limit, whatever the limit asked for', () => {
    const page = pageOf(rows(50, 100), { offset: 0, limit: 50, maxChars: 1_000 })

    expect(JSON.stringify(page).length).toBeLessThanOrEqual(1_000)
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.length).toBeLessThan(50)
    expect(decodeCursor(page.nextCursor!)).toBe(page.items.length)
  })

  it('MCP-2: the last page has no cursor', () => {
    const page = pageOf(rows(5), { offset: 3, limit: 25, maxChars: 10_000 })

    expect(page.items.map((row) => row.id)).toEqual(['row-3', 'row-4'])
    expect(page).not.toHaveProperty('nextCursor')
  })

  it('MCP-2: a page always makes progress, even when one item alone is over the limit', () => {
    const page = pageOf(rows(3, 5_000), { offset: 0, limit: 25, maxChars: 1_000 })

    expect(page.items).toHaveLength(1)
    expect(decodeCursor(page.nextCursor!)).toBe(1)
  })

  it('MCP-2: short text is returned whole, with no continuation', () => {
    expect(truncated('{"a":1}', { offset: 0, maxChars: 1_000, tool: 'get_task' })).toEqual({
      body: '{"a":1}',
    })
  })

  it('MCP-2: long text is cut within the limit, and the continuation names the tool and the offset', () => {
    const text = 'abcdefghij'.repeat(100)

    const first = truncated(text, { offset: 0, maxChars: 400, tool: 'get_document' })

    expect(first.body.length + first.continuation!.length).toBeLessThanOrEqual(400)
    expect(text.startsWith(first.body)).toBe(true)
    expect(first.continuation).toContain('get_document')
    expect(first.continuation).toContain(`offset: ${first.body.length}`)
  })

  it('MCP-2: following the continuations reassembles the whole text', () => {
    const text = 'The parser splits invoices by supplier. '.repeat(60)
    let offset: number | undefined = 0
    let assembled = ''
    while (offset !== undefined) {
      const part = truncated(text, { offset, maxChars: 300, tool: 'get_document' })
      assembled += part.body
      offset = part.nextOffset
    }

    expect(assembled).toBe(text)
  })

  it('MCP-2: an offset past the end is refused rather than answered with nothing', () => {
    expect(() => truncated('short', { offset: 99, maxChars: 300, tool: 'get_task' })).toThrow(
      ValidationError,
    )
  })
})
