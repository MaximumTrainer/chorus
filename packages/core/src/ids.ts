import { randomInt } from 'node:crypto'

/**
 * ULIDs — every primary key in Chorus (architecture.md §4.4).
 *
 * Sortable, so "newest first" needs no secondary index. Opaque, so no
 * sequential integer appears in a URL or an API response: a sequential id
 * leaks how much data exists and invites enumeration.
 *
 * Time and randomness are injectable (`createIdGen`) because CLAUDE.md §5
 * requires tests to be deterministic.
 */

/** Crockford base32: no I, L, O or U, to avoid transcription errors. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LENGTH = 10
const RANDOM_LENGTH = 16
const ULID_LENGTH = TIME_LENGTH + RANDOM_LENGTH
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

function encodeTime(millis: number): string {
  let remaining = millis
  let out = ''
  for (let i = 0; i < TIME_LENGTH; i += 1) {
    out = ALPHABET[remaining % 32] + out
    remaining = Math.floor(remaining / 32)
  }
  return out
}

export interface IdGenOptions {
  /** Milliseconds since the epoch. Injected so tests can freeze time. */
  now?: () => number
  /** Returns an integer in [0, 32). Injected so tests can freeze randomness. */
  random?: () => number
}

/**
 * A ULID generator with its own monotonic state.
 *
 * Within a single millisecond the random component is incremented rather than
 * redrawn, so ids created in the same tick still sort in creation order. Two
 * rows written in the same millisecond that sorted arbitrarily would make
 * cursor pagination non-deterministic (TASK-2 AC1, WS-6 AC3).
 */
export function createIdGen(options: IdGenOptions = {}): () => string {
  const now = options.now ?? (() => Date.now())
  const random = options.random ?? (() => randomInt(0, 32))

  let lastTime = -1
  let lastRandom: number[] = []

  return function next(): string {
    const time = now()

    if (time === lastTime) {
      // Increment the random component from its least significant end.
      for (let i = lastRandom.length - 1; i >= 0; i -= 1) {
        if (lastRandom[i]! < 31) {
          lastRandom[i] = lastRandom[i]! + 1
          break
        }
        lastRandom[i] = 0
      }
    } else {
      lastTime = time
      lastRandom = Array.from({ length: RANDOM_LENGTH }, () => random())
    }

    return encodeTime(time) + lastRandom.map((value) => ALPHABET[value]).join('')
  }
}

const defaultGen = createIdGen()

/** A new ULID from the shared generator. */
export function ulid(): string {
  return defaultGen()
}

/** A ULID stamped at a specific instant. Its random component is still random. */
export function ulidAt(when: Date): string {
  return createIdGen({ now: () => when.getTime() })()
}

export function isUlid(value: string): boolean {
  return value.length === ULID_LENGTH && ULID_PATTERN.test(value)
}

/** The instant encoded in a ULID's time component. */
export function decodeUlidTime(id: string): Date {
  if (!isUlid(id)) {
    throw new TypeError(`Not a ULID: "${id}"`)
  }
  let millis = 0
  for (const char of id.slice(0, TIME_LENGTH)) {
    millis = millis * 32 + ALPHABET.indexOf(char)
  }
  return new Date(millis)
}
