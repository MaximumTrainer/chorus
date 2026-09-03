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

export interface ModelProvider {
  readonly name: string
  stream(request: ChatRequest): AsyncIterable<StreamEvent>
  /** One vector per text, in order. */
  embed(texts: readonly string[], model: ModelRef): Promise<number[][]>
}
