import { createHash } from 'node:crypto'
import type {
  ChatRequest,
  GenerateRequest,
  GenerateResult,
  ModelProvider,
  StreamEvent,
} from '@chorus/llm'
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
  /**
   * What a `generate` call returns, already the right shape.
   *
   * Separate from `chunks` because structured output is a different call, not
   * a differently-formatted stream — scripting it as text would let a test pass
   * against a provider that never looked at the schema.
   */
  readonly structured?: unknown
  /**
   * Output shaped like the schema but failing it — a missing required field, a
   * wrong type.
   *
   * The failure path is the whole reason `generate` exists, so a fake that
   * could not produce one would leave the behaviour that matters untested
   * (CLAUDE.md §4: extend the fake, do not stub around it).
   */
  readonly schemaInvalid?: unknown
}

export interface RecordedRequest {
  readonly model: ModelRef
  readonly messages: ChatRequest['messages']
  /** Every message joined, which is what most assertions actually want. */
  readonly prompt: string
  readonly workspaceId: string
  readonly purpose: string
  /** The schema the call was constrained to, when it was a `generate`. */
  readonly schemaName?: string
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

/**
 * Recovers an object from scripted chunks, so a test can script the prose case.
 *
 * Mirrors the tolerance `packages/llm` applies to a provider that ignores the
 * format instruction and explains itself first.
 */
function parseFromChunks(chunks: readonly string[]): unknown {
  const text = chunks.join('')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
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

    async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
      recorded.push({
        model: request.model,
        messages: request.messages,
        prompt: request.messages.map((message) => message.content).join('\n\n'),
        workspaceId: request.context.workspaceId,
        purpose: request.context.purpose,
        schemaName: request.schemaName,
      })

      if (current.failWith) throw new Error(current.failWith)

      // Validated here rather than returned raw, so the fake enforces the same
      // guarantee a real provider does: a caller holding a result may rely on
      // its shape. A fake that skipped this would let a scripted-but-wrong
      // value reach code that a real provider would never have handed it.
      const candidate =
        current.schemaInvalid !== undefined
          ? current.schemaInvalid
          : current.structured !== undefined
            ? current.structured
            : parseFromChunks(current.chunks ?? [])

      const result = request.schema.safeParse(candidate)
      if (!result.success) {
        const problems = result.error.issues
          .map((issue) => {
            const path = issue.path.join('.')
            return path ? `${path}: ${issue.message}` : issue.message
          })
          .join('; ')
        throw new Error(
          `the model returned output that does not satisfy "${request.schemaName}" (${problems})`,
        )
      }

      return {
        value: result.data,
        usage: current.usage ?? { inputTokens: 1, outputTokens: 1 },
      }
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
