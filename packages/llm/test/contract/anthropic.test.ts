import {
  describeModelProviderContract,
  CONTRACT_CHUNKS,
  CONTRACT_USAGE,
  CONTRACT_VALUE,
  CONTRACT_TOOL_ARGS,
  type ModelProviderHarness,
} from '../../src/testing/contract-kit.js'
import { createAnthropicProvider } from '../../src/providers/anthropic.js'

/**
 * NFR-2 AC2 — the same contract kit, a different provider.
 *
 * Nothing here is Anthropic-shaped except the wire samples. The suite that runs
 * is byte-identical to the one the OpenAI-compatible provider passes, which is
 * what makes "one provider-agnostic interface" a fact rather than a claim.
 *
 * The wire format is genuinely different in the places that matter, and that is
 * the point of running the same assertions over it: usage is split across two
 * frames — `input_tokens` on `message_start`, `output_tokens` on
 * `message_delta` — so a provider that reads usage from one frame reports half
 * the cost, and reports it confidently.
 */

/** SSE with named events, which is how Anthropic frames a stream. */
function sse(events: readonly { event: string; data: unknown }[]): string {
  return (
    events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}`).join('\n\n') +
    '\n\n'
  )
}

const START = {
  event: 'message_start',
  data: {
    type: 'message_start',
    message: {
      id: 'msg_contract_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-test-1',
      content: [],
      stop_reason: null,
      // Input tokens arrive here and nowhere else.
      usage: { input_tokens: CONTRACT_USAGE.inputTokens, output_tokens: 0 },
    },
  },
}

const BLOCK_START = {
  event: 'content_block_start',
  data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
}

const DELTAS = CONTRACT_CHUNKS.map((text) => ({
  event: 'content_block_delta',
  data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
}))

const BLOCK_STOP = {
  event: 'content_block_stop',
  data: { type: 'content_block_stop', index: 0 },
}

const MESSAGE_DELTA = {
  event: 'message_delta',
  data: {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    // Output tokens arrive here, in a frame a naive client stops reading before.
    usage: { output_tokens: CONTRACT_USAGE.outputTokens },
  },
}

const MESSAGE_STOP = { event: 'message_stop', data: { type: 'message_stop' } }

function providerWith(
  respond: (url: string) => Response,
  apiKey = 'sk-ant-contract-test',
): ReturnType<typeof createAnthropicProvider> {
  return createAnthropicProvider({
    apiKey,
    fetch: (async (input: Parameters<typeof fetch>[0]) => respond(String(input))) as unknown as typeof fetch,
  })
}

function streamResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** A non-streaming message, where structured output arrives as a text block. */
function message(text: string): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_contract_2',
      type: 'message',
      role: 'assistant',
      model: 'claude-test-1',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: CONTRACT_USAGE.inputTokens,
        output_tokens: CONTRACT_USAGE.outputTokens,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/** A tool-use block, whose arguments stream as `input_json_delta` fragments. */
function toolCallFrames(index: number, id: string, args: unknown) {
  const json = JSON.stringify(args)
  const cut = Math.floor(json.length / 2)
  return [
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id, name: 'read_file', input: {} },
      },
    },
    // Split mid-argument, which is what a real stream does.
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: json.slice(0, cut) },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: json.slice(cut) },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index } },
  ]
}

const harness: ModelProviderHarness = {
  ref: { provider: 'anthropic', model: 'claude-test-1' },

  streaming: () =>
    providerWith((url) => {
      if (!url.includes('/v1/messages')) throw new Error(`unexpected path: ${url}`)
      return streamResponse(
        sse([START, BLOCK_START, ...DELTAS, BLOCK_STOP, MESSAGE_DELTA, MESSAGE_STOP]),
      )
    }),

  // The connection ends after one delta: no `message_delta`, no `message_stop`.
  truncated: () => providerWith(() => streamResponse(sse([START, BLOCK_START, DELTAS[0]!]))),

  toolCalling: () =>
    providerWith(() =>
      streamResponse(
        sse([START, ...toolCallFrames(0, 'toolu_1', CONTRACT_TOOL_ARGS), MESSAGE_DELTA, MESSAGE_STOP]),
      ),
    ),

  toolCallingParallel: () =>
    providerWith(() =>
      streamResponse(
        sse([
          START,
          ...toolCallFrames(0, 'toolu_1', CONTRACT_TOOL_ARGS),
          ...toolCallFrames(1, 'toolu_2', { path: 'src/billing/post.ts' }),
          MESSAGE_DELTA,
          MESSAGE_STOP,
        ]),
      ),
    ),

  counting: () => {
    let calls = 0
    const provider = providerWith(() => {
      calls += 1
      return new Response(JSON.stringify({ input_tokens: 9 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    return { provider, upstreamCalls: () => calls }
  },

  generating: () => providerWith(() => message(JSON.stringify(CONTRACT_VALUE))),

  generatingInvalid: () => providerWith(() => message(JSON.stringify({ tags: ['billing'] }))),

  generatingWithProse: () =>
    providerWith(() =>
      message(`Here is the draft:

${JSON.stringify(CONTRACT_VALUE)}

Hope that helps.`),
    ),

  leaking: (apiKey: string) =>
    providerWith(
      () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: `key ${apiKey} is not authorised` },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      apiKey,
    ),

  // Anthropic has no embedding endpoint. Asserting the refusal is what stops a
  // misconfigured `embed` tier from indexing a corpus of nothing.
  embeddingUnsupported: () => providerWith(() => new Response('{}', { status: 200 })),
}

describeModelProviderContract('anthropic', harness)
