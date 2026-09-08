import { describe, it, expect } from 'vitest'
import { createAnthropicProvider } from './anthropic.js'

/**
 * NFR-8 — counting tokens against an endpoint that cannot count them.
 *
 * `messages/count_tokens` is Anthropic's own endpoint, and a gateway speaking
 * the Anthropic wire format need not implement it. OpenRouter's does not: a
 * live smoke run against it returned 404, which made every count throw.
 *
 * That matters because the spend guard is built on counting. A deployment
 * pointed at such a gateway would have every model-calling job fail before it
 * started — the guard failing *closed*, which is not obviously better than no
 * guard at all and is a great deal more confusing.
 */
describe('NFR-8 anthropic token counting', () => {
  const ref = { provider: 'anthropic', model: 'claude-test-1' }

  function providerWith(respond: (url: string) => Response) {
    return createAnthropicProvider({
      apiKey: 'sk-ant-test',
      fetch: (async (input: Parameters<typeof fetch>[0]) =>
        respond(String(input))) as unknown as typeof fetch,
    })
  }

  it('NFR-8: a gateway without a counting endpoint gets an estimate, not a failure', async () => {
    const provider = providerWith(
      () =>
        new Response(JSON.stringify({ error: { message: 'Not Found', code: 404 } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    )

    const text = 'The invoice parser does three jobs and should do one.'
    const count = await provider.countTokens(text, ref)

    // A number the guard can use, erring high: it is better to ask about a job
    // that would not have crossed the limit than to let one through that would.
    expect(count).toBeGreaterThan(0)
    expect(count).toBeGreaterThanOrEqual(Math.ceil(text.length / 4))
  })

  it('NFR-8: a real error still fails, rather than being estimated away', async () => {
    // The distinction that makes the fallback safe. 404 means "this endpoint
    // does not exist here"; 401 means the credential is wrong, and silently
    // returning a plausible number for that would hide a broken deployment
    // behind a guard that appeared to be working.
    const provider = providerWith(
      () =>
        new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    )

    await expect(provider.countTokens('some text', ref)).rejects.toThrow()
  })

  it('NFR-8: an endpoint that does count is believed', async () => {
    const provider = providerWith(
      () =>
        new Response(JSON.stringify({ input_tokens: 9 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )

    // The exact count, not an estimate near it. An endpoint that answers is the
    // authority on its own tokeniser.
    expect(await provider.countTokens('The invoice parser does three jobs.', ref)).toBe(9)
  })
})
