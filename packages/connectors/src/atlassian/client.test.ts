import { describe, it, expect } from 'vitest'
import { RateLimitedError, UpstreamError } from '@chorus/core'
import { createAtlassianClient } from './client.js'
import type { ConnectorContext } from '../contract.js'

/**
 * INT-9 — the Atlassian HTTP client shared by Jira and Confluence.
 *
 * The auth is identical across Atlassian products — a Bearer token, a rotating
 * refresh token, the same rate-limit and error shapes — so it lives in one
 * place rather than being copied and diverging. These prove the behaviours both
 * connectors depend on: a 401 refreshes once and retries and the rotated token
 * is persisted, a 429 is retryable, and any other failure names the product and
 * its reason.
 */

const frozen = new Date('2026-09-02T12:00:00.000Z')

function context(fetchImpl: typeof fetch, saved: Record<string, unknown>[]): ConnectorContext {
  return {
    workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    integrationId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
    credentials: { accessToken: 'old-access', refreshToken: 'old-refresh' },
    config: {},
    now: () => frozen,
    fetch: fetchImpl,
    saveCredentials: async (c) => {
      saved.push(c as Record<string, unknown>)
    },
  }
}

describe('INT-9 Atlassian client', () => {
  it('INT-9: a 401 refreshes once, retries, and persists the rotated refresh token', async () => {
    const calls: Array<{ url: string; method: string }> = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = String(url)
      calls.push({ url: u, method: (init?.method ?? 'GET').toUpperCase() })
      if (u.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'rotated-refresh' }), { status: 200 })
      }
      // First data call 401s; the retry (after refresh) succeeds.
      const dataCalls = calls.filter((c) => c.url.endsWith('/thing')).length
      return new Response(JSON.stringify({ ok: dataCalls > 1 }), { status: dataCalls > 1 ? 200 : 401 })
    }) as unknown as typeof fetch

    const saved: Record<string, unknown>[] = []
    const client = createAtlassianClient({
      apiUrl: 'https://api.test',
      fetch: fetchImpl,
      product: 'Confluence',
      clientId: 'app',
      clientSecret: 'secret',
    })
    const body = await client.get('/thing', context(fetchImpl, saved))

    expect(body).toEqual({ ok: true })
    expect(saved[0]).toMatchObject({ accessToken: 'new-access', refreshToken: 'rotated-refresh' })
  })

  it('INT-9: a 429 is raised as retryable with the requested delay', async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(JSON.stringify({}), { status: 429, headers: { 'retry-after': '45' } })) as unknown as typeof fetch
    const client = createAtlassianClient({ apiUrl: 'https://api.test', fetch: fetchImpl, product: 'Confluence' })

    const raised = await client
      .get('/thing', context(fetchImpl, []))
      .then(() => undefined)
      .catch((e: unknown) => e)

    expect(raised).toBeInstanceOf(RateLimitedError)
    expect((raised as RateLimitedError).retryAfterMs).toBe(45_000)
  })

  it('INT-9: another failure names the product and its reason', async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(JSON.stringify({ message: 'space not found' }), { status: 404 })) as unknown as typeof fetch
    const client = createAtlassianClient({
      apiUrl: 'https://api.test',
      fetch: fetchImpl,
      product: 'Confluence',
      reason: (raw) => (JSON.parse(raw) as { message?: string }).message ?? raw,
    })

    const raised = await client
      .get('/thing', context(fetchImpl, []))
      .then(() => undefined)
      .catch((e: unknown) => e)

    expect(raised).toBeInstanceOf(UpstreamError)
    expect((raised as UpstreamError).message).toMatch(/Confluence responded 404/)
    expect((raised as UpstreamError).message).toMatch(/space not found/)
  })
})
