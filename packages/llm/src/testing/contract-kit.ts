import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type { ModelProvider, StreamEvent } from '../provider.js'
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

/** The schema a rigged `generate` provider is asked for, and its name. */
export const CONTRACT_SCHEMA = z.object({
  title: z.string().min(1, 'an artefact needs a title'),
  tags: z.array(z.string()).optional(),
})
export const CONTRACT_SCHEMA_NAME = 'contract_draft'

/** The value a rigged `generate` provider must return. */
export const CONTRACT_VALUE = { title: 'The invoice parser does three jobs', tags: ['billing'] }

/** The tool a rigged tool-calling provider is offered, and what it must call. */
export const CONTRACT_TOOL = {
  name: 'read_file',
  description: 'Reads a file from the repository.',
  inputSchema: z.object({ path: z.string(), pattern: z.string().optional() }),
}

/**
 * Arguments a rigged tool call must produce.
 *
 * The path carries forward slashes and the pattern a Unicode escape, both on
 * purpose: providers differ in how they escape JSON strings, and a consumer
 * that string-matched raw fragments passes until it meets one that escapes
 * differently.
 */
export const CONTRACT_TOOL_ARGS = { path: 'src/billing/parse.ts', pattern: 'café' }

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

  /**
   * Streams one tool call whose arguments arrive across several frames.
   *
   * Split mid-argument on purpose: a provider that assumed one frame is one
   * complete argument drops part of every large call, and only under load.
   */
  toolCalling(): ModelProvider

  /** Streams two tool calls in one turn, interleaved. */
  toolCallingParallel(): ModelProvider

  /**
   * Counts tokens, and records how many times it asked upstream.
   *
   * The count itself is the provider's business — one is exact, the other
   * estimates — so the kit asserts the contract rather than a number: a
   * positive integer, and the same text counted twice costs one call.
   */
  counting(): { provider: ModelProvider; upstreamCalls: () => number }

  /** Returns `CONTRACT_VALUE` as structured output. */
  generating(): ModelProvider

  /**
   * Returns an object of the wrong shape — `title` missing.
   *
   * The failure path is the reason `generate` exists at all, so a provider that
   * could not be rigged into it would leave the behaviour that matters
   * untested.
   */
  generatingInvalid(): ModelProvider

  /**
   * Returns the object with prose wrapped around it.
   *
   * Providers do ignore a format instruction and explain themselves first, and
   * losing a good draft to a preamble helps nobody. Tolerated deliberately, so
   * it is asserted rather than accidental.
   */
  generatingWithProse(): ModelProvider

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
      expect(usage).toMatchObject(CONTRACT_USAGE)
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

    it('NFR-2: a tool call arrives incrementally, then complete', async () => {
      const events: StreamEvent[] = []
      for await (const event of harness.toolCalling().stream({
        model: ref,
        messages: [{ role: 'user', content: 'Read the parser.' }],
        context: CONTEXT,
        tools: [CONTRACT_TOOL],
      })) {
        events.push(event)
      }

      const start = events.find((e) => e.type === 'tool_call_start')
      const deltas = events.filter((e) => e.type === 'tool_call_delta')
      const end = events.find((e) => e.type === 'tool_call_end')

      expect(start, 'a tool call must announce itself before its arguments').toMatchObject({
        name: CONTRACT_TOOL.name,
      })
      // More than one, or nothing was streamed and the caller may as well have
      // waited for the whole response.
      expect(deltas.length).toBeGreaterThan(1)
      expect(end).toBeDefined()

      // The fragments concatenate to what the completed call reports, so a
      // consumer rendering progress and a consumer acting on the result agree.
      const joined = deltas.map((e) => (e as { argumentsDelta: string }).argumentsDelta).join('')
      expect(JSON.parse(joined)).toEqual(CONTRACT_TOOL_ARGS)
      expect((end as { arguments: unknown }).arguments).toEqual(CONTRACT_TOOL_ARGS)

      // Every event for a call carries the same id, or a caller with two calls
      // in flight cannot tell which deltas belong to which.
      const id = (start as { id: string }).id
      expect(deltas.every((e) => (e as { id: string }).id === id)).toBe(true)
      expect((end as { id: string }).id).toBe(id)

      expect(events.at(-1)?.type).toBe('done')
    })

    it('NFR-2: parallel tool calls stay distinguishable', async () => {
      const events: StreamEvent[] = []
      for await (const event of harness.toolCallingParallel().stream({
        model: ref,
        messages: [{ role: 'user', content: 'Read both.' }],
        context: CONTEXT,
        tools: [CONTRACT_TOOL],
      })) {
        events.push(event)
      }

      const ends = events.filter((e) => e.type === 'tool_call_end') as Array<{
        id: string
        arguments: Record<string, unknown>
      }>

      // Two calls, two ids, two distinct argument sets — not one call whose
      // arguments are the concatenation of both, which is what an
      // accumulator keyed on nothing produces.
      expect(ends).toHaveLength(2)
      expect(new Set(ends.map((e) => e.id)).size).toBe(2)
      expect(ends.map((e) => e.arguments.path).sort()).toEqual([
        'src/billing/parse.ts',
        'src/billing/post.ts',
      ])
    })

    it('NFR-8: countTokens returns a positive count for real text', async () => {
      const { provider } = harness.counting()
      const count = await provider.countTokens('The invoice parser does three jobs.', ref)

      expect(Number.isInteger(count)).toBe(true)
      expect(count).toBeGreaterThan(0)
    })

    it('NFR-8 AC6: the same text counted twice costs one upstream call', async () => {
      // Counting is what makes the spend guard a guard rather than a
      // notification, so it runs before work rather than after it — often on
      // the same prefix. Paying a round trip each time would make the guard
      // cost more than the call it is protecting.
      const { provider, upstreamCalls } = harness.counting()
      const text = 'The invoice parser does three jobs.'

      const first = await provider.countTokens(text, ref)
      const second = await provider.countTokens(text, ref)

      expect(second).toBe(first)
      // At most one, not exactly one: a provider that estimates locally makes
      // no round trip at all, and demanding one would be asserting on how the
      // answer is obtained rather than on what the caller is promised.
      expect(upstreamCalls()).toBeLessThanOrEqual(1)
    })

    it('NFR-2: generate returns a value validated against the schema', async () => {
      const result = await harness.generating().generate({
        model: ref,
        messages: [{ role: 'user', content: 'Draft it.' }],
        context: CONTEXT,
        schema: CONTRACT_SCHEMA,
        schemaName: CONTRACT_SCHEMA_NAME,
      })

      expect(result.value).toEqual(CONTRACT_VALUE)
      expect(result.usage).toMatchObject(CONTRACT_USAGE)
    })

    it('NFR-2: generate rejects output of the wrong shape, naming the field', async () => {
      // Rejecting rather than returning a partial value is the entire contract.
      // A caller holding a result may rely on its shape; one holding a
      // half-populated object has to re-check everything `generate` promised.
      await expect(
        harness.generatingInvalid().generate({
          model: ref,
          messages: [{ role: 'user', content: 'Draft it.' }],
          context: CONTEXT,
          schema: CONTRACT_SCHEMA,
          schemaName: CONTRACT_SCHEMA_NAME,
        }),
      ).rejects.toThrow(/title/i)
    })

    it('NFR-2: generate recovers an object wrapped in prose', async () => {
      const result = await harness.generatingWithProse().generate({
        model: ref,
        messages: [{ role: 'user', content: 'Draft it.' }],
        context: CONTEXT,
        schema: CONTRACT_SCHEMA,
        schemaName: CONTRACT_SCHEMA_NAME,
      })

      expect(result.value).toEqual(CONTRACT_VALUE)
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
