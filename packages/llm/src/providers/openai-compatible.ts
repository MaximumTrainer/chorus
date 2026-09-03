import { UpstreamError } from '@chorus/core'
import type { ChatRequest, ModelProvider, StreamEvent } from '../provider.js'
import type { ModelRef } from '../types.js'

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

/**
 * Strips anything that would put the credential in a log or a health row.
 *
 * Provider errors reach run traces and health pages that people read, and an
 * upstream is perfectly capable of echoing the key back in its own message.
 */
function redact(text: string, apiKey: string | undefined): string {
  return apiKey ? text.split(apiKey).join('[redacted]') : text
}

function headersFor(apiKey: string | undefined): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  }
}

interface ChatDelta {
  choices?: Array<{ delta?: { content?: string } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export function createOpenAiCompatibleProvider(
  options: OpenAiCompatibleOptions,
): ModelProvider {
  const http = options.fetch ?? fetch
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

            const text = parsed.choices?.[0]?.delta?.content
            if (typeof text === 'string' && text !== '') yield { type: 'token', text }
          }
        }

        // The server closed without a terminator. Reported as done rather than
        // as an error: the tokens already yielded are real, and the caller has
        // to be told the stream ended either way.
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
