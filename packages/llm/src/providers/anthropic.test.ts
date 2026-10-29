import { describe, it, expect } from 'vitest'
import { z } from 'zod'
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

/**
 * NFR-2 — the structured-output request shape (#199).
 *
 * The contract kit mocks the response and never inspects what was sent, so it
 * could not catch that `generate` posted a field the live API rejects. This
 * asserts the wire shape directly: `output_config.format` is the SDK's
 * `JSONOutputFormat` — `{ type: 'json_schema', schema }` — and nothing more.
 * A live smoke returned `output_config.format.name: Extra inputs are not
 * permitted`, which is the regression this pins.
 */
describe('NFR-2 anthropic structured output', () => {
  const ref = { provider: 'anthropic', model: 'claude-test-1' }
  const schema = z.object({ answer: z.string() })

  /** Captures the request body `generate` posts, and answers with `value`. */
  function capturing(value: unknown) {
    const bodies: Array<Record<string, unknown>> = []
    const provider = createAnthropicProvider({
      apiKey: 'sk-ant-test',
      fetch: (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (init?.body) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-test-1',
            content: [{ type: 'text', text: JSON.stringify(value) }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as typeof fetch,
    })
    return { provider, bodies }
  }

  it('NFR-2: generate sends output_config.format as a bare json_schema, with no name (#199)', async () => {
    const { provider, bodies } = capturing({ answer: 'yes' })

    await provider.generate({
      model: ref,
      messages: [{ role: 'user', content: 'is it?' }],
      context: { workspaceId: 'w', teamId: 't', purpose: 'chat' },
      schema,
      schemaName: 'answer',
    })

    const format = (bodies[0]!.output_config as { format: Record<string, unknown> }).format
    expect(format.type).toBe('json_schema')
    // The live API rejects any key here beyond type and schema.
    expect(Object.keys(format).sort()).toEqual(['schema', 'type'])
    // And it requires every object be strict, with no dialect marker (#199).
    const schemaJson = format.schema as Record<string, unknown>
    expect(schemaJson.additionalProperties).toBe(false)
    expect(schemaJson.$schema).toBeUndefined()
  })

  it('NFR-2: nested objects in the schema are made strict too (#199)', async () => {
    const { provider, bodies } = capturing({ outer: { inner: 'x' } })

    await provider.generate({
      model: ref,
      messages: [{ role: 'user', content: 'nest' }],
      context: { workspaceId: 'w', teamId: 't', purpose: 'chat' },
      schema: z.object({ outer: z.object({ inner: z.string() }) }),
      schemaName: 'nested',
    })

    const schemaJson = (bodies[0]!.output_config as { format: { schema: Record<string, unknown> } })
      .format.schema

    // Wherever zod placed the nested object — inline or under $defs — every
    // object node must be strict.
    const objects: Array<Record<string, unknown>> = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (node === null || typeof node !== 'object') return
      const record = node as Record<string, unknown>
      if (record.type === 'object' || 'properties' in record) objects.push(record)
      Object.values(record).forEach(walk)
    }
    walk(schemaJson)

    expect(objects.length, 'the root and the nested object are both object nodes').toBeGreaterThanOrEqual(2)
    for (const object of objects) expect(object.additionalProperties).toBe(false)
  })
})
