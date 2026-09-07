import Anthropic from '@anthropic-ai/sdk'
import { ConfigurationError } from '@chorus/core'
import type {
  ChatMessage,
  ChatRequest,
  GenerateRequest,
  GenerateResult,
  ModelProvider,
  StreamEvent,
} from '../provider.js'
import type { ModelRef, TokenUsage } from '../types.js'
import { redact } from './redact.js'
import { jsonSchemaFor, parseStructured } from './structured.js'

/**
 * The Anthropic provider (NFR-2, ADR-0018).
 *
 * Written against `@anthropic-ai/sdk` rather than `fetch`, which is the
 * opposite of the choice the OpenAI-compatible provider makes — deliberately,
 * and for a reason that does not transfer between them. That provider is
 * `fetch`-based because one client reaching many endpoints is its entire value;
 * an SDK there would collapse it to one vendor. This provider reaches exactly
 * one vendor by definition, so the argument has nothing to bite on, and what is
 * left is a stream whose framing a hand-rolled client gets wrong: usage split
 * across two frames, named events, and a token count in the frame after the one
 * a naive reader stops at.
 *
 * The dependency stays inside `packages/llm`, where the boundary suite already
 * confines it. Nothing outside this package may import it (ADR-0005).
 */

export interface AnthropicOptions {
  readonly apiKey: string
  /** Overridden by a gateway or a proxy; defaults to the public API. */
  readonly baseUrl?: string
  /** Injected so the contract kit drives the parser without a server. */
  readonly fetch?: typeof fetch
  readonly name?: string
}

/**
 * The output ceiling when a caller names none.
 *
 * Deliberately conservative. Every current Claude model accepts at least this
 * much, so a tier re-pointed at a smaller model does not start returning 400s —
 * which is the failure ADR-0015's "re-pointing a tier must not require a code
 * change" exists to prevent. A caller that needs more says so.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192

/**
 * Splits Chorus's flat message list into Anthropic's shape.
 *
 * System messages are a top-level parameter there, not a role in the
 * conversation. Passing one through as a `user` turn would work, and would
 * quietly cost the prompt its cacheable prefix (§9.3) while reading as
 * instructions the model may argue with rather than instructions it follows.
 */
function split(messages: readonly ChatMessage[]): {
  system: string | undefined
  turns: Array<{ role: 'user' | 'assistant'; content: string }>
} {
  const system: string[] = []
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = []

  for (const message of messages) {
    if (message.role === 'system') {
      system.push(message.content)
      continue
    }
    turns.push({ role: message.role, content: message.content })
  }

  return { system: system.length > 0 ? system.join('\n\n') : undefined, turns }
}

export function createAnthropicProvider(options: AnthropicOptions): ModelProvider {
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    // The router owns fallback and records every one of them on the run
    // (NFR-2 AC3). A retry hidden inside the client is a fallback nothing sees,
    // and it doubles the latency budget of a call that was going to fail.
    maxRetries: 0,
  })

  return {
    name: options.name ?? 'anthropic',

    async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      const { system, turns } = split(request.messages)
      const usage: { inputTokens: number; outputTokens: number } = {
        inputTokens: 0,
        outputTokens: 0,
      }

      try {
        const events = await client.messages.create(
          {
            model: request.model.model,
            max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            messages: turns,
            ...(system ? { system } : {}),
            stream: true,
          },
          { ...(request.signal ? { signal: request.signal } : {}) },
        )

        for await (const event of events) {
          // Input tokens arrive once, on the opening frame, and never again.
          if (event.type === 'message_start') {
            usage.inputTokens = event.message.usage.input_tokens
            usage.outputTokens = event.message.usage.output_tokens ?? 0
            continue
          }

          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            if (event.delta.text !== '') yield { type: 'token', text: event.delta.text }
            continue
          }

          // Output tokens arrive here — in the frame after the last delta,
          // which is where a client that stops at `content_block_stop` loses
          // half the cost of every call it makes.
          if (event.type === 'message_delta') {
            usage.outputTokens = event.usage.output_tokens
          }
        }

        // Reported as done even when the stream ended without `message_stop`.
        // The tokens already yielded are real, and a consumer that is never
        // told the stream ended waits forever.
        yield { type: 'done', usage: usage as TokenUsage }
      } catch (error) {
        // Yielded rather than thrown: a consumer iterating a stream that threw
        // has to handle two failure shapes, and one of them is easy to forget.
        yield {
          type: 'error',
          message: redact(
            error instanceof Error ? error.message : String(error),
            options.apiKey,
          ),
        }
      }
    },

    async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
      const { system, turns } = split(request.messages)

      // The schema goes to the provider as an output format, not into the
      // prompt as a request. A model told to produce this shape is constrained
      // to it; a model asked nicely for it is not.
      const response = await client.messages.create(
        {
          model: request.model.model,
          max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          messages: turns,
          ...(system ? { system } : {}),
          output_config: {
            format: {
              type: 'json_schema',
              name: request.schemaName,
              schema: jsonSchemaFor(request.schema as never),
            },
          },
        } as never,
        { ...(request.signal ? { signal: request.signal } : {}) },
      )

      const text = response.content
        .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
        .join('')

      return {
        value: parseStructured(text, request.schema, request.schemaName),
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      }
    },

    async embed(_texts: readonly string[], model: ModelRef): Promise<number[][]> {
      // Anthropic serves no embedding endpoint. Refusing here rather than
      // returning nothing is what stops a misconfigured `embed` tier from
      // indexing a corpus of empty vectors — which does not fail, it just
      // makes retrieval return confident nonsense (§9.1).
      throw new ConfigurationError(
        `The anthropic provider cannot embed: it serves no embedding endpoint. ` +
          `Point the "embed" tier at an OpenAI-compatible embedding model instead of ` +
          `"${model.model}".`,
        { provider: 'anthropic', model: model.model },
      )
    },
  }
}
