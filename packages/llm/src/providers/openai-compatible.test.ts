import { describe, it, expect } from 'vitest'
import { createOpenAiCompatibleProvider } from './openai-compatible.js'
import type { StreamEvent } from '../provider.js'

/**
 * NFR-2 — the OpenAI-compatible provider.
 *
 * One wire format reaches OpenAI, Azure, Ollama, LM Studio, vLLM and most
 * self-hosted servers, which is what makes NFR-1's "no mandatory SaaS
 * dependency except the chosen model endpoint" true in practice rather than in
 * principle. It is written against `fetch` rather than a vendor SDK — the SDK
 * would be a dependency that only speaks to one of them, and the boundary rule
 * exists precisely to stop that.
 *
 * The tests drive it with a scripted `fetch`, because what is under test is our
 * parsing of the wire format: the framing, the terminator, and the failure
 * modes that a real endpoint produces and a happy-path test never sees.
 */

const ref = { provider: 'openai-compatible', model: 'a-model' }
const context = { workspaceId: 'w', teamId: 't', purpose: 'chat' as const }

/** An SSE body in the shape a compatible server sends. */
function sseBody(...frames: string[]): Response {
  return new Response(frames.map((frame) => `data: ${frame}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const delta = (text: string): string => JSON.stringify({ choices: [{ delta: { content: text } }] })

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const all: StreamEvent[] = []
  for await (const event of events) all.push(event)
  return all
}

describe('NFR-2 OpenAI-compatible provider', () => {
  it('NFR-2: a streamed completion arrives as tokens and one done', async () => {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: 'http://models.test/v1',
      apiKey: 'k',
      fetch: async () =>
        sseBody(
          delta('Hello'),
          delta(' world'),
          JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 2 } }),
          '[DONE]',
        ),
    })

    const events = await collect(
      provider.stream({ model: ref, messages: [{ role: 'user', content: 'hi' }], context }),
    )

    expect(events.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text)).toEqual([
      'Hello',
      ' world',
    ])
    const done = events.at(-1)
    // Usage arrives with `done`, because a stream that ended without saying
    // what it cost is a gap in the spend ledger nothing can reconstruct (NFR-8).
    expect(done).toMatchObject({ type: 'done', usage: { inputTokens: 7, outputTokens: 2 } })
  })

  it('NFR-2: the [DONE] terminator is not parsed as JSON', async () => {
    // The one framing detail every hand-rolled client gets wrong the first
    // time: the terminator is a literal, not a payload, and parsing it throws
    // at the very end of an otherwise perfect stream.
    const provider = createOpenAiCompatibleProvider({
      baseUrl: 'http://models.test/v1',
      fetch: async () => sseBody(delta('ok'), '[DONE]'),
    })

    const events = await collect(
      provider.stream({ model: ref, messages: [{ role: 'user', content: 'hi' }], context }),
    )
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.at(-1)!.type).toBe('done')
  })

  it('NFR-2: a frame split across chunks is reassembled', async () => {
    // A real endpoint splits wherever the network does, not on frame
    // boundaries. A client that assumed one chunk is one frame drops tokens
    // under load and only under load.
    const whole = `data: ${delta('split')}\n\ndata: [DONE]\n\n`
    const provider = createOpenAiCompatibleProvider({
      baseUrl: 'http://models.test/v1',
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const bytes = new TextEncoder().encode(whole)
              controller.enqueue(bytes.slice(0, 12))
              controller.enqueue(bytes.slice(12, 30))
              controller.enqueue(bytes.slice(30))
              controller.close()
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    })

    const events = await collect(
      provider.stream({ model: ref, messages: [{ role: 'user', content: 'hi' }], context }),
    )
    expect(events.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text)).toEqual(
      ['split'],
    )
  })

  it('NFR-2: an HTTP failure ends the stream with an error, not a hang', async () => {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: 'http://models.test/v1',
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 }),
    })

    const events = await collect(
      provider.stream({ model: ref, messages: [{ role: 'user', content: 'hi' }], context }),
    )
    // A consumer waiting on a stream that simply stopped waits forever.
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error' })
    expect((events[0] as { message: string }).message).toMatch(/model not found/)
  })

  it('NFR-2: the API key never appears in an error message', async () => {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: 'http://models.test/v1',
      apiKey: 'sk-averysecretkey',
      fetch: async () => new Response('upstream said sk-averysecretkey was rejected', { status: 401 }),
    })

    const events = await collect(
      provider.stream({ model: ref, messages: [{ role: 'user', content: 'hi' }], context }),
    )
    // Provider errors reach run traces and health rows that people read.
    expect(JSON.stringify(events)).not.toContain('sk-averysecretkey')
  })

  it('NFR-2: embeddings come back in the order they were sent', async () => {
    // The endpoint returns an `index` per embedding and is not obliged to
    // return them in order. Trusting array position silently pairs the wrong
    // vector with the wrong chunk, which nothing downstream can detect.
    const provider = createOpenAiCompatibleProvider({
      baseUrl: 'http://models.test/v1',
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [0.2] },
              { index: 0, embedding: [0.1] },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    })

    expect(await provider.embed(['first', 'second'], ref)).toEqual([[0.1], [0.2]])
  })

  it('NFR-2: an embedding response that is short of vectors fails loudly', async () => {
    // Padding with zeroes would give a chunk a vector that matches everything
    // weakly — confident nonsense rather than an absence.
    const provider = createOpenAiCompatibleProvider({
      baseUrl: 'http://models.test/v1',
      fetch: async () =>
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1] }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    })

    await expect(provider.embed(['a', 'b'], ref)).rejects.toThrow(
      /returned 1 vectors for 2 inputs/,
    )
  })

  it('NFR-2: the request names the configured model and carries the key', async () => {
    let seen: { url: string; body: Record<string, unknown>; auth: string | null } | undefined
    const provider = createOpenAiCompatibleProvider({
      baseUrl: 'http://models.test/v1',
      apiKey: 'k',
      fetch: async (url, init) => {
        seen = {
          url: String(url),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          auth: new Headers(init?.headers).get('authorization'),
        }
        return sseBody('[DONE]')
      },
    })

    await collect(
      provider.stream({ model: ref, messages: [{ role: 'user', content: 'hi' }], context }),
    )

    expect(seen!.url).toBe('http://models.test/v1/chat/completions')
    expect(seen!.body.model).toBe('a-model')
    expect(seen!.body.stream).toBe(true)
    expect(seen!.auth).toBe('Bearer k')
  })

  it('NFR-2: a local endpoint needs no key', async () => {
    // Ollama and LM Studio take no credential, and requiring one would make the
    // local profile impossible — which is the profile NFR-1 turns on.
    let auth: string | null = 'unset'
    const provider = createOpenAiCompatibleProvider({
      baseUrl: 'http://localhost:11434/v1',
      fetch: async (_url, init) => {
        auth = new Headers(init?.headers).get('authorization')
        return sseBody('[DONE]')
      },
    })

    await collect(
      provider.stream({ model: ref, messages: [{ role: 'user', content: 'hi' }], context }),
    )
    expect(auth).toBeNull()
  })
})
