import { UpstreamError } from '@chorus/core'
import type {
  ChatRequest,
  ToolSpec,
  GenerateRequest,
  GenerateResult,
  ModelProvider,
  StreamEvent,
} from '../provider.js'
import type { ModelRef } from '../types.js'
import { redact } from './redact.js'
import { jsonSchemaFor, parseStructured } from './structured.js'
import { createTokenCountCache } from './token-count-cache.js'

/**
 * A provider speaking the OpenAI-compatible wire format (NFR-1, NFR-2).
 *
 * One format reaches OpenAI, Azure OpenAI, Ollama, LM Studio, vLLM, Together
 * and most self-hosted servers. That is what makes NFR-1's "no mandatory SaaS
 * dependency except the chosen model endpoint" true in practice rather than in
 * principle: a self-hoster points `CHORUS_MODEL_BASE_URL` at their own machine
 * and everything works.
 *
 * Written against `fetch`, not a vendor SDK. An SDK would be a dependency that
 * speaks to exactly one of those endpoints, which is the vendor lock-in
 * arriving by accumulation that ADR-0005's boundary rule exists to stop.
 */

export interface OpenAiCompatibleOptions {
  /** Includes the version path, e.g. `https://api.openai.com/v1`. */
  readonly baseUrl: string
  /** Absent for a local endpoint. Ollama and LM Studio take no credential. */
  readonly apiKey?: string
  /** Injected so tests drive the parser without a server. */
  readonly fetch?: typeof fetch
  readonly name?: string
}

function headersFor(apiKey: string | undefined): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  }
}

interface ToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface ChatDelta {
  choices?: Array<{ delta?: { content?: string; tool_calls?: ToolCallDelta[] } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** Tool definitions in the OpenAI-compatible shape, from the one Zod source. */
function toolsFor(tools: readonly ToolSpec[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: jsonSchemaFor(tool.inputSchema),
    },
  }))
}

/**
 * The accumulated argument text, as an object.
 *
 * An empty string means a tool that takes no arguments, which is `{}` rather
 * than a failure.
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
 * Characters per token, for the estimate below.
 *
 * Four is the usual rule of thumb for English prose and code in the
 * byte-pair-encoding family every OpenAI-compatible server uses. It is an
 * estimate and is documented as one; the alternative is bundling a tokeniser
 * per model, which would be wrong for the local endpoints this provider exists
 * to reach and would still be wrong whenever one of them updated.
 */
const CHARS_PER_TOKEN = 4

export function createOpenAiCompatibleProvider(
  options: OpenAiCompatibleOptions,
): ModelProvider {
  const http = options.fetch ?? fetch
  const tokenCounts = createTokenCountCache()
  const base = options.baseUrl.replace(/\/+$/, '')

  return {
    name: options.name ?? 'openai-compatible',

    async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      let response: Response
      try {
        response = await http(`${base}/chat/completions`, {
          method: 'POST',
          headers: headersFor(options.apiKey),
          body: JSON.stringify({
            model: request.model.model,
            messages: request.messages,
            stream: true,
            // Asking for usage on the final frame; servers that do not support
            // it simply omit it, and the `done` event then reports zeroes
            // rather than failing.
            stream_options: { include_usage: true },
            ...(toolsFor(request.tools) ? { tools: toolsFor(request.tools) } : {}),
            ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
          }),
          ...(request.signal ? { signal: request.signal } : {}),
        })
      } catch (error) {
        // Yielded rather than thrown: a consumer iterating a stream that threw
        // has to handle two failure shapes, and one of them is easy to forget.
        yield {
          type: 'error',
          message: redact(error instanceof Error ? error.message : String(error), options.apiKey),
        }
        return
      }

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '')
        yield {
          type: 'error',
          message: redact(
            `the model endpoint responded ${response.status}: ${detail.slice(0, 300)}`,
            options.apiKey,
          ),
        }
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      // A real endpoint splits wherever the network does, not on frame
      // boundaries, so a partial frame is carried into the next chunk. A client
      // that assumed one chunk is one frame drops tokens under load, and only
      // under load.
      let buffered = ''
      let usage = { inputTokens: 0, outputTokens: 0 }
      // Keyed by the delta's `index`, which is the only field every frame for a
      // call carries — the id and name arrive once, on the first. Keying on
      // anything else merges two parallel calls into one whose arguments are
      // the concatenation of both, and that parses.
      const calls = new Map<number, { id: string; name: string; json: string }>()

      /** Completes every open call, in index order. */
      function* finishCalls(): Generator<StreamEvent> {
        for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
          calls.delete(index)
          yield {
            type: 'tool_call_end',
            id: call.id,
            name: call.name,
            arguments: parseArguments(call.json),
          }
        }
      }

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffered += decoder.decode(value, { stream: true })

          let boundary = buffered.indexOf('\n\n')
          while (boundary !== -1) {
            const frame = buffered.slice(0, boundary).trim()
            buffered = buffered.slice(boundary + 2)
            boundary = buffered.indexOf('\n\n')

            if (!frame.startsWith('data:')) continue
            const payload = frame.slice('data:'.length).trim()

            // The terminator is a literal, not a payload. Parsing it as JSON
            // throws at the very end of an otherwise perfect stream, which is
            // the framing detail every hand-rolled client gets wrong once.
            if (payload === '[DONE]') {
              yield* finishCalls()
              yield { type: 'done', usage }
              return
            }

            let parsed: ChatDelta
            try {
              parsed = JSON.parse(payload) as ChatDelta
            } catch {
              // A frame we cannot read is skipped rather than fatal: it is
              // usually a keep-alive or a vendor extension, and killing the
              // stream over one would be worse than ignoring it.
              continue
            }

            if (parsed.usage) {
              usage = {
                inputTokens: parsed.usage.prompt_tokens ?? 0,
                outputTokens: parsed.usage.completion_tokens ?? 0,
              }
            }

            for (const delta of parsed.choices?.[0]?.delta?.tool_calls ?? []) {
              const index = delta.index ?? 0
              let call = calls.get(index)
              if (!call) {
                call = { id: delta.id ?? `call_${index}`, name: delta.function?.name ?? '', json: '' }
                calls.set(index, call)
                yield { type: 'tool_call_start', id: call.id, name: call.name }
              }
              const fragment = delta.function?.arguments
              if (typeof fragment === 'string' && fragment !== '') {
                call.json += fragment
                yield { type: 'tool_call_delta', id: call.id, argumentsDelta: fragment }
              }
            }

            const text = parsed.choices?.[0]?.delta?.content
            if (typeof text === 'string' && text !== '') yield { type: 'token', text }
          }
        }

        // The server closed without a terminator. Reported as done rather than
        // as an error: the tokens already yielded are real, and the caller has
        // to be told the stream ended either way.
        yield* finishCalls()
        yield { type: 'done', usage }
      } catch (error) {
        yield {
          type: 'error',
          message: redact(error instanceof Error ? error.message : String(error), options.apiKey),
        }
      } finally {
        reader.releaseLock()
      }
    },

    async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
      // `json_schema` with `strict`, which is the only form that constrains the
      // model rather than merely suggesting a shape. Endpoints that do not
      // support it ignore it and return prose — which the tolerant parse below
      // still recovers, and the schema still rejects if it is wrong.
      const response = await http(`${base}/chat/completions`, {
        method: 'POST',
        headers: headersFor(options.apiKey),
        body: JSON.stringify({
          model: request.model.model,
          messages: request.messages,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: request.schemaName,
              strict: true,
              schema: jsonSchemaFor(request.schema as never),
            },
          },
          ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new UpstreamError(
          redact(
            `the model endpoint responded ${response.status}: ${detail.slice(0, 300)}`,
            options.apiKey,
          ),
          { status: response.status },
        )
      }

      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }

      const text = body.choices?.[0]?.message?.content ?? ''
      return {
        value: parseStructured(text, request.schema, request.schemaName),
        usage: {
          inputTokens: body.usage?.prompt_tokens ?? 0,
          outputTokens: body.usage?.completion_tokens ?? 0,
        },
      }
    },

    async countTokens(text: string, model: ModelRef): Promise<number> {
      // Estimated, not exact. The OpenAI-compatible format has no token-count
      // endpoint, and this provider deliberately reaches servers — Ollama, LM
      // Studio, vLLM — whose tokenisers it cannot know. Rounded *up*, so a
      // spend guard errs toward asking rather than toward overspending.
      return tokenCounts.get(model, text, () =>
        Promise.resolve(Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN))),
      )
    },

    async embed(texts: readonly string[], model: ModelRef): Promise<number[][]> {
      const response = await http(`${base}/embeddings`, {
        method: 'POST',
        headers: headersFor(options.apiKey),
        body: JSON.stringify({ model: model.model, input: texts }),
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new UpstreamError(
          redact(
            `the embedding endpoint responded ${response.status}: ${detail.slice(0, 300)}`,
            options.apiKey,
          ),
          { status: response.status },
        )
      }

      const body = (await response.json()) as {
        data?: Array<{ index?: number; embedding?: number[] }>
      }
      const data = body.data ?? []

      // Short of vectors: fail rather than pad. A padded zero vector matches
      // everything weakly, so retrieval returns confident nonsense instead of
      // an absence — and nothing downstream can tell the difference.
      if (data.length !== texts.length) {
        throw new UpstreamError(
          `the embedding endpoint returned ${data.length} vectors for ${texts.length} inputs`,
          { expected: texts.length, received: data.length },
        )
      }

      // Ordered by the reported index, not by array position. The endpoint is
      // not obliged to return them in order, and trusting position silently
      // pairs the wrong vector with the wrong chunk.
      const ordered = new Array<number[]>(texts.length)
      for (const [position, entry] of data.entries()) {
        const index = typeof entry.index === 'number' ? entry.index : position
        if (!Array.isArray(entry.embedding)) {
          throw new UpstreamError('the embedding endpoint returned a vector-less entry', { index })
        }
        ordered[index] = entry.embedding
      }
      return ordered
    },
  }
}
