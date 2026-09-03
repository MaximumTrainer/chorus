import { createHash } from 'node:crypto'
import type { ChatRequest, ModelProvider, StreamEvent } from '@chorus/llm'
import type { ModelRef } from '@chorus/llm'

/**
 * A scriptable model provider (CLAUDE.md §4).
 *
 * Never a real model from a test. That rule is usually explained as cost and
 * flakiness, but the stronger reason is that a real model makes a test
 * *unfalsifiable*: it answers plausibly whatever the prompt contains, so a
 * retrieval bug that sent the wrong context still produces a convincing reply
 * and a passing assertion.
 *
 * This fake therefore does two jobs. It returns exactly what a test scripted,
 * and it **records every request**, so a test can assert on what the model was
 * given rather than only on what came back. The second is the one that catches
 * real bugs.
 *
 * Shipped in `packages/testing` and maintained like production code, because
 * every acceptance test's trustworthiness rests on its fidelity.
 */

export interface FakeModelScript {
  /** Streamed one at a time, in order. */
  readonly chunks?: readonly string[]
  /** Ends the stream with an error instead, to exercise the failure path. */
  readonly failWith?: string
  /** Emits nothing and never completes, so a timeout path can be tested. */
  readonly hang?: boolean
  readonly usage?: { inputTokens: number; outputTokens: number }
}

export interface RecordedRequest {
  readonly model: ModelRef
  readonly messages: ChatRequest['messages']
  /** Every message joined, which is what most assertions actually want. */
  readonly prompt: string
  readonly workspaceId: string
  readonly purpose: string
}

export interface FakeModelProvider extends ModelProvider {
  /** Replaces the script. Later calls use the new one. */
  script(next: FakeModelScript): void
  requests(): readonly RecordedRequest[]
  /**
   * The same deterministic embedding the provider produces, exposed so a test
   * can index with it and query with it and have the two agree.
   */
  embedText(text: string): number[]
}

const DIMENSIONS = 1536

/**
 * A deterministic embedding with a useful property: texts sharing words land
 * near each other.
 *
 * A random vector would make retrieval untestable — every chunk equidistant, so
 * "the right chunk came back" could never be asserted. Hashing each word into a
 * dimension is crude, and enough for a test to distinguish a relevant chunk
 * from an irrelevant one, which is all retrieval has to demonstrate here.
 */
function deterministicEmbedding(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0)
  const words = text.toLowerCase().match(/[a-z0-9_./-]+/g) ?? []

  for (const word of words) {
    const digest = createHash('sha256').update(word).digest()
    const dimension = digest.readUInt32BE(0) % DIMENSIONS
    vector[dimension] = (vector[dimension] ?? 0) + 1
  }

  // Normalised, so cosine distance behaves and a long file does not beat a
  // short one merely by being long.
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude)
}

export function createFakeModelProvider(initial: FakeModelScript = {}): FakeModelProvider {
  let current: FakeModelScript = { chunks: ['ok'], ...initial }
  const recorded: RecordedRequest[] = []

  return {
    name: 'fake',

    script(next) {
      current = next
    },

    requests() {
      return recorded
    },

    embedText: deterministicEmbedding,

    async embed(texts) {
      return texts.map(deterministicEmbedding)
    },

    async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      recorded.push({
        model: request.model,
        messages: request.messages,
        prompt: request.messages.map((message) => message.content).join('\n\n'),
        workspaceId: request.context.workspaceId,
        purpose: request.context.purpose,
      })

      if (current.hang) {
        // Resolves only when the caller aborts, so a timeout test does not have
        // to wait for real time to pass.
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return
      }

      if (current.failWith) {
        yield { type: 'error', message: current.failWith }
        return
      }

      for (const text of current.chunks ?? []) {
        yield { type: 'token', text }
      }

      yield {
        type: 'done',
        usage: current.usage ?? {
          inputTokens: request.messages.reduce((sum, m) => sum + m.content.length, 0),
          outputTokens: (current.chunks ?? []).join('').length,
        },
      }
    },
  }
}
