import { z } from 'zod'
import { ForbiddenError, UpstreamError, type Tool, type ToolContext } from '@chorus/core'

/**
 * `fetch_url` (AGENT-5 AC6, architecture.md §11.7).
 *
 * The issue calls the allow-list "a defence against prompt injection driving
 * exfiltration", and that framing drives the whole design. The threat is not a
 * user asking for a bad URL — it is *retrieved content containing an
 * instruction* and a model following it. So the check cannot be advisory, and
 * it must survive every way one URL can be made to look like another.
 *
 * Four of those ways have their own test, because each defeats an
 * implementation that looks correct: a suffix comparison (`docs.example.com`
 * matches `docs.example.com.evil.test`), a userinfo segment
 * (`https://docs.example.com@evil.test/`), a non-HTTP scheme (`file:///`), and
 * a redirect — which is controlled by the *remote*, and would otherwise carry
 * the request straight past a check that already passed.
 */

export interface FetchUrlOptions {
  /**
   * Hosts this deployment permits. Compared exactly against the parsed host.
   *
   * An empty list refuses everything. That is the direction a default must fail
   * in: a deployment that configured no hosts has not opted into unrestricted
   * web access.
   */
  readonly allowedHosts: readonly string[]
}

const MAX_BODY_BYTES = 128 * 1024
const MAX_REDIRECTS = 3

const Input = z.object({
  url: z.string().min(1),
})

const Output = z.object({
  finalUrl: z.string(),
  status: z.number(),
  contentType: z.string().nullable(),
  body: z.string(),
  truncated: z.boolean(),
})

export function createFetchUrlTool(
  options: FetchUrlOptions,
): Tool<z.infer<typeof Input>, z.infer<typeof Output>> {
  const allowed = new Set(options.allowedHosts.map((host) => host.toLowerCase()))

  /** Parses and checks in one place, so no path reaches the network unchecked. */
  function permitted(raw: string): URL {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new ForbiddenError('That is not a URL', { url: raw })
    }

    // `file:` reads the container's disk; `data:` and `ftp:` reach places a
    // fetch policy does not describe. Only the two schemes the allow-list is
    // written about are fetchable.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ForbiddenError(`Only http and https may be fetched, not ${url.protocol}`, {
        url: raw,
      })
    }

    // `url.hostname`, never the raw string. A suffix comparison matches
    // `docs.example.com.evil.test`, and a raw-string comparison is fooled by
    // `https://docs.example.com@evil.test/` where the allowed-looking part is a
    // username.
    if (!allowed.has(url.hostname.toLowerCase())) {
      throw new ForbiddenError(`Host "${url.hostname}" is not allow-listed for fetch_url`, {
        host: url.hostname,
      })
    }

    return url
  }

  return {
    name: 'fetch_url',
    description:
      'Fetch the contents of an allow-listed URL. Returns the response body as text, truncated.',
    input: Input,
    output: Output,
    // A read. Gating it behind before_external_write would train people to
    // approve without reading, and the allow-list is the control that matters.
    sideEffect: 'none',
    requiredRole: 'member',
    requiredScopes: [],

    async execute(input, ctx: ToolContext) {
      const http = ctx.fetch
      if (!http) {
        // A run granted no network cannot acquire one by calling a tool.
        throw new ForbiddenError('This run has no network access', { tool: 'fetch_url' })
      }

      let target = permitted(input.url)

      for (let hop = 0; ; hop++) {
        if (hop > MAX_REDIRECTS) {
          // Bounded so a redirect loop cannot hang a run indefinitely.
          throw new UpstreamError('Too many redirects', { url: target.toString() })
        }

        // `manual`, so a redirect is *our* decision. Letting fetch follow it
        // would carry the request to a host the allow-list never saw — and the
        // remote controls where it points.
        const response = await http(target.toString(), { redirect: 'manual' })

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          if (!location) {
            throw new UpstreamError('A redirect gave no location', { url: target.toString() })
          }
          // Re-checked against the allow-list, which is the entire point.
          target = permitted(new URL(location, target).toString())
          continue
        }

        const raw = await response.text()
        const truncated = raw.length > MAX_BODY_BYTES
        return {
          finalUrl: target.toString(),
          status: response.status,
          contentType: response.headers.get('content-type'),
          // Truncated so one page cannot fill a context window — and so a
          // hostile page cannot crowd out the instructions around it.
          body: truncated ? raw.slice(0, MAX_BODY_BYTES) : raw,
          truncated,
        }
      }
    },
  }
}
