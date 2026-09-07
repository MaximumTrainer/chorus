import {
  describeModelProviderContract,
  CONTRACT_CHUNKS,
  CONTRACT_USAGE,
  CONTRACT_VECTORS,
  CONTRACT_VALUE,
  type ModelProviderHarness,
} from '../../src/testing/contract-kit.js'
import { createOpenAiCompatibleProvider } from '../../src/providers/openai-compatible.js'

/**
 * NFR-2 AC1 — the contract kit, run against the provider that already existed.
 *
 * This file is written before the Anthropic provider and passes without the
 * OpenAI-compatible provider changing. That is the assertion that matters: a
 * kit authored alongside a new implementation describes *that* implementation,
 * and would let the new provider define the contract it is supposed to satisfy.
 *
 * The wire samples below are hand-written rather than recorded, deliberately.
 * They have to include a truncated stream and an upstream that quotes the
 * credential back — neither of which a real endpoint produces on request, and
 * both of which are the cases a hand-rolled client gets wrong.
 */

const API_PATH_CHAT = '/chat/completions'
const API_PATH_EMBED = '/embeddings'

/** `data:`-framed SSE, terminated by the `[DONE]` literal. */
function sse(frames: readonly unknown[], terminate = true): string {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}`)
  if (terminate) body.push('data: [DONE]')
  return body.join('\n\n') + '\n\n'
}

const STREAM_FRAMES = [
  ...CONTRACT_CHUNKS.map((content) => ({ choices: [{ delta: { content } }] })),
  {
    choices: [{ delta: {} }],
    usage: {
      prompt_tokens: CONTRACT_USAGE.inputTokens,
      completion_tokens: CONTRACT_USAGE.outputTokens,
    },
  },
]

/** Builds a provider whose upstream answers with `respond`. */
function providerWith(
  respond: (url: string) => Response,
  apiKey = 'sk-openai-compatible-test',
): ReturnType<typeof createOpenAiCompatibleProvider> {
  return createOpenAiCompatibleProvider({
    baseUrl: 'https://models.invalid/v1',
    apiKey,
    fetch: (async (input: Parameters<typeof fetch>[0]) => respond(String(input))) as unknown as typeof fetch,
  })
}

/** A non-streaming completion carrying `content`, which is where JSON arrives. */
function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: {
        prompt_tokens: CONTRACT_USAGE.inputTokens,
        completion_tokens: CONTRACT_USAGE.outputTokens,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

const harness: ModelProviderHarness = {
  ref: { provider: 'openai-compatible', model: 'test-mid-1' },

  streaming: () =>
    providerWith((url) => {
      if (!url.endsWith(API_PATH_CHAT)) throw new Error(`unexpected path: ${url}`)
      return new Response(sse(STREAM_FRAMES), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }),

  // No `[DONE]`, and the usage frame never arrives — the connection simply
  // ends, which is what a dropped upstream looks like from here.
  truncated: () =>
    providerWith(
      () =>
        new Response(sse([{ choices: [{ delta: { content: CONTRACT_CHUNKS[0] } }] }], false), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    ),

  generating: () => providerWith(() => completion(JSON.stringify(CONTRACT_VALUE))),

  generatingInvalid: () =>
    providerWith(() => completion(JSON.stringify({ tags: ['billing'] }))),

  generatingWithProse: () =>
    providerWith(() =>
      completion(`Here is the draft:

${JSON.stringify(CONTRACT_VALUE)}

Hope that helps.`),
    ),

  leaking: (apiKey: string) =>
    providerWith(
      () =>
        new Response(`{"error":{"message":"key ${apiKey} is not authorised for this model"}}`, {
          status: 401,
        }),
      apiKey,
    ),

  // Deliberately reversed, each tagged with the index it belongs at. A provider
  // trusting array position pairs every vector with the wrong text.
  embedding: () =>
    providerWith((url) => {
      if (!url.endsWith(API_PATH_EMBED)) throw new Error(`unexpected path: ${url}`)
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: CONTRACT_VECTORS[1] },
            { index: 0, embedding: CONTRACT_VECTORS[0] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }),

  embeddingShort: () =>
    providerWith(
      () =>
        new Response(JSON.stringify({ data: [{ index: 0, embedding: CONTRACT_VECTORS[0] }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
}

describeModelProviderContract('openai-compatible', harness)
