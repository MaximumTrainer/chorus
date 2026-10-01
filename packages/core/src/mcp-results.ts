import { ValidationError } from './errors.js'

/**
 * Keeping an MCP result within bounds (MCP-2 AC2, architecture.md §14).
 *
 * A tool result lands in an agent's context window. An unbounded one wastes
 * tokens and can crowd out the task the agent was asked to do, so every result
 * is held under a limit in one of two ways: a list is served a page at a time
 * behind an opaque cursor, and anything still too long is cut with an explicit
 * instruction for reading the rest.
 */

const CURSOR_PREFIX = 'o:'

/**
 * An opaque cursor for the item at `offset`.
 *
 * Opaque so an agent passes it back rather than doing arithmetic on it, which
 * leaves the representation free to change when lists gain keyset pagination.
 */
export function encodeCursor(offset: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${offset}`, 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  const match = /^o:(\d{1,9})$/.exec(decoded)
  if (!match) {
    throw new ValidationError(
      'cursor is not one this server issued. Pass back the nextCursor from the previous page exactly, or omit it to start from the beginning',
      { field: 'cursor' },
    )
  }
  return Number(match[1])
}

export interface Page<T> {
  readonly items: T[]
  readonly nextCursor?: string
}

/**
 * The page of `items` starting at `offset`: at most `limit` of them, and fewer
 * if that many would serialise past `maxChars`.
 *
 * A page always holds at least one item, even one that is over the limit on
 * its own, so following the cursors always reaches the end. That one item is
 * then cut like any other long result.
 */
export function pageOf<T>(
  items: readonly T[],
  options: { offset: number; limit: number; maxChars: number },
): Page<T> {
  const { offset, limit, maxChars } = options
  const end = Math.min(items.length, offset + limit)
  // The envelope with the longest cursor this page could carry, so the sum
  // below never under-counts.
  const envelope = JSON.stringify({ items: [], nextCursor: encodeCursor(end) }).length

  const picked: T[] = []
  let size = envelope
  for (let index = offset; index < end; index++) {
    const itemSize = JSON.stringify(items[index]).length + (picked.length > 0 ? 1 : 0)
    if (picked.length > 0 && size + itemSize > maxChars) break
    picked.push(items[index]!)
    size += itemSize
  }

  const next = offset + picked.length
  return next < items.length ? { items: picked, nextCursor: encodeCursor(next) } : { items: picked }
}

/** Room kept for the continuation line; far more than it takes. */
const CONTINUATION_RESERVE = 200

export interface Truncated {
  readonly body: string
  /** Present only when there is more: the instruction an agent reads to get it. */
  readonly continuation?: string
  readonly nextOffset?: number
}

/**
 * `text` from `offset`, cut so the body and its continuation line together
 * stay within `maxChars`.
 *
 * The continuation names the tool and the exact offset to pass, because an
 * agent follows an instruction far more reliably than it infers a protocol.
 */
export function truncated(
  text: string,
  options: { offset: number; maxChars: number; tool: string },
): Truncated {
  const { offset, maxChars, tool } = options
  if (offset > 0 && offset >= text.length) {
    throw new ValidationError(
      `offset ${offset} is past the end of this result, which is ${text.length} characters long. Call ${tool} without an offset to read it from the start`,
      { field: 'offset' },
    )
  }
  if (text.length - offset <= maxChars && offset === 0) return { body: text }

  let end = Math.min(text.length, offset + Math.max(1, maxChars - CONTINUATION_RESERVE))
  // Never split a surrogate pair: half a character is not a character on
  // either side of the cut.
  const last = text.charCodeAt(end - 1)
  if (end < text.length && end - 1 > offset && last >= 0xd800 && last <= 0xdbff) end--

  const body = text.slice(offset, end)
  if (end >= text.length) return { body }
  return {
    body,
    continuation:
      `\n\n[Truncated: characters ${offset} to ${end} of ${text.length} shown. ` +
      `Call ${tool} again with the same arguments and offset: ${end} to read on.]`,
    nextOffset: end,
  }
}
