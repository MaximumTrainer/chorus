import type { ZodType } from 'zod'
import type { CallContext, ModelRef, TokenUsage } from './types.js'

/**
 * What a provider can actually be asked to do (architecture.md §9).
 *
 * The router decides *which* model; this is how one is called. Both live in
 * `packages/llm` because nothing outside it may name a provider or a model
 * (ADR-0005), and the dependency-boundary suite enforces that.
 *
 * Streaming is the primary shape rather than an option. A product whose first
 * promise is a conversation cannot treat incremental output as a variant of
 * request/response: the non-streaming case is the easy one to build on top, and
 * building it the other way round means retrofitting streaming into every
 * caller later.
 */

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

export interface ChatRequest {
  readonly model: ModelRef
  readonly messages: readonly ChatMessage[]
  readonly context: CallContext
  readonly maxOutputTokens?: number
  /** Aborts an in-flight call — a closed connection, a cancelled run. */
  readonly signal?: AbortSignal
}

/**
 * One event in a streamed reply.
 *
 * `usage` arrives with `done` rather than being returned separately, because a
 * stream that ended without reporting what it cost is a gap in the spend ledger
 * that nothing can reconstruct afterwards (NFR-8).
 */
export type StreamEvent =
  | { readonly type: 'token'; readonly text: string }
  | { readonly type: 'done'; readonly usage: TokenUsage }
  | { readonly type: 'error'; readonly message: string }

/**
 * A request for output the caller can rely on the shape of (§9.1).
 *
 * The schema is sent to the provider, not merely checked on the way back. That
 * is the whole difference: asking in prose and parsing afterwards makes every
 * malformed reply a caller's problem to detect, and the detection that stood
 * here before returned `undefined` — indistinguishable, downstream, from a
 * model that had nothing to say.
 */
export interface GenerateRequest<T> {
  readonly model: ModelRef
  readonly messages: readonly ChatMessage[]
  readonly context: CallContext
  /** Validated on the way back, and sent as a constraint on the way out. */
  readonly schema: ZodType<T>
  /**
   * What to call the schema on the wire.
   *
   * Providers require a name for the format they are given, and it appears in
   * provider-side errors — so a meaningful one is the difference between a
   * diagnosable failure and `schema_0 was not satisfied`.
   */
  readonly schemaName: string
  readonly maxOutputTokens?: number
  readonly signal?: AbortSignal
}

export interface GenerateResult<T> {
  readonly value: T
  readonly usage: TokenUsage
}

export interface ModelProvider {
  readonly name: string
  stream(request: ChatRequest): AsyncIterable<StreamEvent>
  /**
   * Structured output, validated against `schema` before it returns.
   *
   * Throws rather than returning a partial value. A caller that receives a
   * `GenerateResult` may rely on its shape, which is the only property that
   * makes this worth having over `stream`.
   */
  generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>>
  /** One vector per text, in order. */
  embed(texts: readonly string[], model: ModelRef): Promise<number[][]>
}
