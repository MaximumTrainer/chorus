import { describe, it, expect } from 'vitest'
import type { ModelProvider } from '../provider.js'
import type { ModelRef, TokenUsage } from '../types.js'

/**
 * The `ModelProvider` contract kit (NFR-2).
 *
 * Every provider must pass exactly this suite. Until there were two of them,
 * the "one provider-agnostic interface" NFR-2 promises was a description of the
 * single implementation that happened to exist — a guarantee holding for one
 * provider and not another is not a guarantee.
 *
 * The kit asserts **behaviour, never encoding**. Each provider speaks a
 * different wire format, so a harness supplies providers already rigged into
 * the scenario the kit needs; what the kit checks is that the same rigging
 * produces the same observable outcome whichever provider served it. That
 * division is the whole point: a caller must be able to swap providers without
 * learning anything about either.
 *
 * Shipped code, maintained like production code, for the same reason the fakes
 * in `packages/testing` are (CLAUDE.md §4) — its fidelity is what makes every
 * provider's tests worth anything.
 */

/** The text a rigged streaming provider must produce, split as it streams. */
export const CONTRACT_CHUNKS: readonly string[] = ['The parser ', 'does three jobs.']

/** The usage a rigged streaming provider must report on `done`. */
export const CONTRACT_USAGE: TokenUsage = { inputTokens: 11, outputTokens: 7 }

/** The vectors a rigged embedding provider must return, for two inputs. */
export const CONTRACT_VECTORS: readonly number[][] = [
  [0.5, 0.25, 0],
  [0, 0.75, 0.5],
]

export interface ModelProviderHarness {
  /** A model reference the rigged providers answer to. */
  readonly ref: ModelRef

  /** Streams `CONTRACT_CHUNKS` and reports `CONTRACT_USAGE`. */
  streaming(): ModelProvider

  /**
   * Upstream refuses, and echoes `apiKey` back inside its own error body.
   *
   * An upstream is perfectly capable of quoting the credential it just
   * rejected, and provider errors reach run traces and health pages that people
   * read. A provider that passes the body through verbatim leaks the key.
   */
  leaking(apiKey: string): ModelProvider

  /**
   * The connection drops mid-stream, after some tokens but before any
   * terminator.
   *
   * The tokens already yielded are real, and the caller has to be told the
   * stream ended either way — a provider that simply stops iterating leaves the
   * consumer waiting forever.
   */
  truncated(): ModelProvider

  /** Returns `CONTRACT_VECTORS`, out of order, each tagged with its index. */
  embedding?(): ModelProvider

  /**
   * Returns fewer vectors than it was given inputs.
   *
   * Padding here is worse than failing: a zero vector matches everything
   * weakly, so retrieval returns confident nonsense instead of an absence, and
   * nothing downstream can tell the difference.
   */
  embeddingShort?(): ModelProvider

  /**
   * The provider cannot embed at all — Anthropic has no embedding endpoint.
   *
   * Supplied instead of `embedding` by a chat-only provider, so "this provider
   * does not embed" is an asserted refusal rather than an untested gap.
   */
  embeddingUnsupported?(): ModelProvider
}

const CONTEXT = {
  workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  teamId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
  purpose: 'chat',
} as const

/** Drains a stream into the events it produced, in order. */
async function drain(
  provider: ModelProvider,
  ref: ModelRef,
  signal?: AbortSignal,
): Promise<{ text: string; usage: TokenUsage | undefined; errors: string[]; kinds: string[] }> {
  let text = ''
  let usage: TokenUsage | undefined
  const errors: string[] = []
  const kinds: string[] = []

  for await (const event of provider.stream({
    model: ref,
    messages: [{ role: 'user', content: 'What does the invoice parser do?' }],
    context: CONTEXT,
    ...(signal ? { signal } : {}),
  })) {
    kinds.push(event.type)
    if (event.type === 'token') text += event.text
    if (event.type === 'done') usage = event.usage
    if (event.type === 'error') errors.push(event.message)
  }

  return { text, usage, errors, kinds }
}

export function describeModelProviderContract(name: string, harness: ModelProviderHarness): void {
  const ref = harness.ref

  describe(`NFR-2 model provider contract: ${name}`, () => {
    it('NFR-2: names itself, so a ledger row and a health page can say who served the call', () => {
      expect(harness.streaming().name).toBeTruthy()
    })

    it('NFR-2: streams tokens in order and ends with done', async () => {
      const { text, kinds } = await drain(harness.streaming(), ref)

      // Order, not just membership: a provider that buffered the reply and
      // emitted it as one token would satisfy a contains-assertion and none of
      // what streaming is for.
      expect(text).toBe(CONTRACT_CHUNKS.join(''))
      expect(kinds.filter((kind) => kind === 'token').length).toBeGreaterThan(1)
      expect(kinds.at(-1)).toBe('done')
    })

    it('NFR-2: the done event carries the usage the stream reported', async () => {
      const { usage } = await drain(harness.streaming(), ref)

      // Usage arrives *with* done rather than separately, because a stream that
      // ended without reporting what it cost is a gap in the spend ledger that
      // nothing can reconstruct afterwards (NFR-8).
      expect(usage).toEqual(CONTRACT_USAGE)
    })

    it('NFR-2: a stream cut short still reports done rather than hanging', async () => {
      const { text, kinds } = await drain(harness.truncated(), ref)

      expect(text.length).toBeGreaterThan(0)
      expect(kinds.at(-1)).toBe('done')
    })

    it('NFR-2: an upstream failure arrives as an error event, not a thrown exception', async () => {
      // Yielded rather than thrown: a consumer iterating a stream that threw has
      // to handle two failure shapes, and one of them is easy to forget.
      const { errors } = await drain(harness.leaking('sk-contract-secret'), ref)

      expect(errors).toHaveLength(1)
      expect(errors[0]).toBeTruthy()
    })

    it('NFR-2 AC3: the credential never appears in an error the caller can see', async () => {
      const apiKey = 'sk-contract-secret'
      const { errors } = await drain(harness.leaking(apiKey), ref)

      expect(errors.join(' ')).not.toContain(apiKey)
    })

    if (harness.embedding) {
      const embedding = harness.embedding

      it('NFR-2: embed returns one vector per input, ordered by the index the endpoint reported', async () => {
        const vectors = await embedding().embed(['first text', 'second text'], ref)

        // Ordered by the reported index, not by array position. The endpoint is
        // not obliged to return them in order, and trusting position silently
        // pairs the wrong vector with the wrong chunk.
        expect(vectors).toEqual(CONTRACT_VECTORS)
      })
    }

    if (harness.embeddingShort) {
      const short = harness.embeddingShort

      it('NFR-2: a short embedding response fails rather than padding', async () => {
        await expect(short().embed(['first text', 'second text'], ref)).rejects.toThrow()
      })
    }

    if (harness.embeddingUnsupported) {
      const unsupported = harness.embeddingUnsupported

      it('NFR-2 AC5: a provider that cannot embed refuses, naming itself', async () => {
        // Returning nothing would let a misconfigured `embed` tier index a
        // corpus of empty vectors, which fails as silently as retrieval can.
        await expect(unsupported().embed(['first text'], ref)).rejects.toThrow(/embed/i)
      })
    }
  })
}
