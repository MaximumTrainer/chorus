import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Recorded HTTP interactions for connector tests (INT-1 AC7, INT-2 AC6).
 *
 * A connector test that calls a live source is a test nobody else can run: it
 * needs an account, it fails when someone else's data changes, and it cannot
 * run in CI. A cassette makes the connector's own parsing and pagination the
 * thing under test, which is what we actually want to know.
 *
 * Two rules make cassettes trustworthy rather than decorative:
 *
 *  1. **An unmatched request is an error, never a 404.** A player that returns
 *     "not found" for a request nobody recorded turns a connector bug into a
 *     silently empty result, and the test passes with nothing in it.
 *  2. **Nothing is recorded unredacted.** Authorization headers, cookies and
 *     anything token-shaped are stripped on the way in, because a cassette is a
 *     committed file and CLAUDE.md §7 is explicit about what may not be in one.
 */

export interface CassetteInteraction {
  readonly request: {
    readonly method: string
    /** Matched exactly, including query string. */
    readonly url: string
  }
  readonly response: {
    readonly status: number
    readonly headers?: Readonly<Record<string, string>>
    /** JSON body, stored as a value rather than a string so cassettes stay readable. */
    readonly body?: unknown
  }
}

export interface Cassette {
  readonly description?: string
  readonly interactions: readonly CassetteInteraction[]
}

/** Where cassettes live: beside the connector they belong to (CLAUDE.md §4). */
export const CASSETTE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function cassettePath(name: string): string {
  return join(CASSETTE_ROOT, ...name.split('/').slice(0, -1), '__cassettes__', name.split('/').pop()!)
}

export function loadCassette(name: string): Cassette {
  const path = cassettePath(name)
  if (!existsSync(path)) {
    throw new Error(`No cassette at ${path}. Record it, or fix the name.`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Cassette
}

/** `fetch` accepts a string, a URL or a Request; all three carry a URL. */
function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return (input as { url: string }).url
}

/** Headers that must never reach a committed file. */
const SECRET_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-hub-signature-256'])

export function redactHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) =>
      SECRET_HEADERS.has(name.toLowerCase()) ? [name, '[redacted]'] : [name, value],
    ),
  )
}

/**
 * A `fetch` that answers from a cassette.
 *
 * Matching is on method and full URL. Deliberately strict: a connector that
 * asks for `?per_page=100` when the cassette recorded `?per_page=30` is a
 * connector whose pagination would behave differently against the real API, and
 * a lenient match would hide exactly that.
 *
 * Interactions are consumed in order when a URL appears more than once, so a
 * cassette can record two different answers to the same request — which is how
 * pagination and retry-after-refresh are expressed.
 */
export function cassettePlayer(name: string): typeof fetch {
  const cassette = loadCassette(name)
  const remaining = cassette.interactions.map((interaction) => ({ interaction, used: false }))

  return (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url = urlOf(input)
    const method = (init?.method ?? 'GET').toUpperCase()

    const entry = remaining.find(
      (candidate) =>
        !candidate.used &&
        candidate.interaction.request.method.toUpperCase() === method &&
        candidate.interaction.request.url === url,
    )

    if (!entry) {
      // Loud, with the whole cassette listed: a silent 404 here would turn a
      // connector bug into an empty result and a passing test.
      const recorded = cassette.interactions
        .map((i) => `  ${i.request.method} ${i.request.url}`)
        .join('\n')
      throw new Error(
        `Cassette "${name}" has no unused interaction for ${method} ${url}.\nRecorded:\n${recorded}`,
      )
    }
    entry.used = true

    const { response } = entry.interaction
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json', ...(response.headers ?? {}) },
    })
  }) as typeof fetch
}

/**
 * Wraps a real `fetch` to record what it does, redacted, for later replay.
 *
 * Shipped rather than improvised so that whoever *does* have an account can
 * produce a cassette the same way every time — and so the redaction is the same
 * code every time, rather than something each contributor remembers or forgets.
 */
export function cassetteRecorder(
  name: string,
  underlying: typeof fetch = fetch,
): typeof fetch & { save(description?: string): void } {
  const interactions: CassetteInteraction[] = []

  const recording = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url = urlOf(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const response = await underlying(input, init)

    const clone = response.clone()
    const text = await clone.text()
    interactions.push({
      request: { method, url },
      response: {
        status: response.status,
        headers: redactHeaders(Object.fromEntries(response.headers.entries())),
        body: text === '' ? undefined : (JSON.parse(text) as unknown),
      },
    })
    return response
  }) as typeof fetch & { save(description?: string): void }

  recording.save = (description?: string) => {
    const path = cassettePath(name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      `${JSON.stringify({ ...(description ? { description } : {}), interactions }, null, 2)}\n`,
      'utf8',
    )
  }

  return recording
}
