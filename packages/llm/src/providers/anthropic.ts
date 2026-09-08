import Anthropic from '@anthropic-ai/sdk'
import { ConfigurationError } from '@chorus/core'
import type {
  ChatMessage,
  ChatRequest,
  ToolSpec,
  GenerateRequest,
  GenerateResult,
  ModelProvider,
  StreamEvent,
} from '../provider.js'
import type { ModelRef, TokenUsage } from '../types.js'
import { redact } from './redact.js'
import { jsonSchemaFor, parseStructured } from './structured.js'
import { createTokenCountCache } from './token-count-cache.js'

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
  /**
   * Overridden by a gateway or a proxy; defaults to the public API.
   *
   * **Without the version path.** The SDK appends `/v1/messages` itself, so a
   * base URL that already ends in `/v1` produces `/v1/v1/messages` and a 404 —
   * the opposite convention to the OpenAI-compatible provider, whose base URL
   * does include it. For OpenRouter that means `https://openrouter.ai/api`.
   */
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
 * The accumulated argument text, as an object.
 *
 * An empty string means the model called a tool that takes no arguments, which
 * is `{}` rather than a failure.
 */
function parseArguments(json: string): Record<string, unknown> {
  if (json.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(json)
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Splits Chorus's flat message list into Anthropic's shape.
 *
 * System messages are a top-level parameter there, not a role in the
 * conversation. Passing one through as a `user` turn would work, and would
 * quietly cost the prompt its cacheable prefix (§9.3) while reading as
 * instructions the model may argue with rather than instructions it follows.
 */
function split(messages: readonly ChatMessage[]): {
  system: unknown[] | undefined
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

  if (system.length === 0) return { system: undefined, turns }

  // §9.3: prompt-prefix caching, where the provider supports it. The system
  // block is the stable half — charter, workflow instructions, output schema —
  // and the cache breakpoint goes at its end, so everything up to it is reused
  // and the volatile turns after it are not.
  //
  // This is only worth anything because the caller assembles the stable part
  // first. Caching is a prefix match, so a breakpoint placed after content that
  // changes every call caches nothing and still pays for the write.
  return {
    system: [
      {
        type: 'text',
        text: system.join('\n\n'),
        cache_control: { type: 'ephemeral' },
      },
    ],
    turns,
  }
}

/** Tool definitions in Anthropic's shape, from the one Zod definition. */
function toolsFor(tools: readonly ToolSpec[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: jsonSchemaFor(tool.inputSchema),
  }))
}

/**
 * Whether an error means "this endpoint does not exist here".
 *
 * Narrow on purpose: anything broader would absorb real failures into a
 * fallback and make them invisible.
 */
function isNotImplemented(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: unknown }).status === 404
  )
}

/**
 * A conservative estimate, when the endpoint cannot count.
 *
 * Four characters per token is the usual rule of thumb for the byte-pair
 * encodings in use, and it rounds **up**, so a spend guard errs toward asking
 * rather than toward overspending. It is an estimate and is documented as one;
 * the alternative is bundling a tokeniser we would then have to keep in step
 * with models we do not control.
 */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

export function createAnthropicProvider(options: AnthropicOptions): ModelProvider {
  const tokenCounts = createTokenCountCache()
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
      const usage: {
        inputTokens: number
        outputTokens: number
        cachedInputTokens: number
      } = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }

      try {
        const events = await client.messages.create(
          {
            model: request.model.model,
            max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            messages: turns,
            ...(system ? { system: system as never } : {}),
            ...(toolsFor(request.tools)
              ? { tools: toolsFor(request.tools) as never }
              : {}),
            stream: true,
          },
          { ...(request.signal ? { signal: request.signal } : {}) },
        )

        // Keyed by content-block index, which is the only thing every frame for
        // a call carries. Two calls in one turn arrive interleaved, and an
        // accumulator keyed on anything else concatenates their arguments.
        const calls = new Map<number, { id: string; name: string; json: string }>()

        for await (const event of events) {
          // Input tokens arrive once, on the opening frame, and never again.
          if (event.type === 'message_start') {
            const reported = event.message.usage as {
              input_tokens: number
              output_tokens?: number
              cache_read_input_tokens?: number
            }
            usage.inputTokens = reported.input_tokens
            usage.outputTokens = reported.output_tokens ?? 0
            // Reported separately by the provider, and kept separate here. A
            // cache read costs about a tenth of a fresh token; added to
            // `inputTokens` the discount is lost and cannot be recovered.
            usage.cachedInputTokens = reported.cache_read_input_tokens ?? 0
            continue
          }

          if (event.type === 'content_block_start') {
            const block = event.content_block as { type: string; id?: string; name?: string }
            if (block.type === 'tool_use' && block.id && block.name) {
              calls.set(event.index, { id: block.id, name: block.name, json: '' })
              yield { type: 'tool_call_start', id: block.id, name: block.name }
            }
            continue
          }

          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            if (event.delta.text !== '') yield { type: 'token', text: event.delta.text }
            continue
          }

          if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
            const call = calls.get(event.index)
            const fragment = event.delta.partial_json
            if (call && fragment !== '') {
              call.json += fragment
              yield { type: 'tool_call_delta', id: call.id, argumentsDelta: fragment }
            }
            continue
          }

          if (event.type === 'content_block_stop') {
            const call = calls.get(event.index)
            if (call) {
              calls.delete(event.index)
              // Parsed here, once. Providers escape JSON strings differently,
              // and a caller string-matching raw fragments breaks on the first
              // escape it has not seen.
              yield {
                type: 'tool_call_end',
                id: call.id,
                name: call.name,
                arguments: parseArguments(call.json),
              }
            }
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
          ...(system ? { system: system as never } : {}),
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

      const reported = response.usage as {
        input_tokens: number
        output_tokens: number
        cache_read_input_tokens?: number
      }
      return {
        value: parseStructured(text, request.schema, request.schemaName),
        usage: {
          inputTokens: reported.input_tokens,
          outputTokens: reported.output_tokens,
          cachedInputTokens: reported.cache_read_input_tokens ?? 0,
        },
      }
    },

    async countTokens(text: string, model: ModelRef): Promise<number> {
      // Exact, from the model's own tokeniser, wherever the endpoint offers
      // one. A local approximation drifts as models change, and a spend guard
      // built on a drifting number stops guarding without anybody noticing.
      return tokenCounts.get(model, text, async () => {
        try {
          const response = await client.messages.countTokens({
            model: model.model,
            messages: [{ role: 'user', content: text }],
          })
          return response.input_tokens
        } catch (error) {
          // `count_tokens` is Anthropic's own endpoint, and a gateway speaking
          // the Anthropic wire format need not implement it — OpenRouter's does
          // not, and returns 404. That is a capability gap rather than a
          // failure, and the difference matters: the spend guard is built on
          // counting, so throwing here would make every model-calling job fail
          // before it started. A guard failing closed is not obviously better
          // than no guard, and is a great deal more confusing.
          //
          // Only 404 is absorbed. A 401 means the credential is wrong and a 429
          // means the account is throttled; returning a plausible number for
          // either would hide a broken deployment behind a guard that looked
          // like it was working.
          if (!isNotImplemented(error)) throw error
          return estimateTokens(text)
        }
      })
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
