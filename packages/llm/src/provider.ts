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

/**
 * A tool the model may call.
 *
 * The schema is Zod, as `generate`'s is, so one definition describes what a
 * tool accepts whether it is being offered to a model or validated on the way
 * back. A second, JSON-shaped copy per provider would drift from the first.
 */
export interface ToolSpec {
  readonly name: string
  /** What it does, in the words the model will decide on. */
  readonly description: string
  readonly inputSchema: ZodType<unknown>
}

export interface ChatRequest {
  readonly model: ModelRef
  readonly messages: readonly ChatMessage[]
  readonly context: CallContext
  /**
   * Tools the model may call. Offering none is the chat case.
   *
   * Requires `streamingToolDeltas` of the resolved model: a provider that
   * streams text but not tool-call deltas cannot serve this, and the router
   * refuses it before the call rather than half-way through one.
   */
  readonly tools?: readonly ToolSpec[]
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
  /** The model has begun a call, and named the tool. Arguments follow. */
  | { readonly type: 'tool_call_start'; readonly id: string; readonly name: string }
  /**
   * A fragment of the arguments, as JSON text.
   *
   * Deltas rather than whole calls because a coding job's arguments are large —
   * a file edit is a diff — and a panel that shows nothing until the whole call
   * has arrived reads as a hang. The fragments are not individually parseable;
   * only their concatenation is.
   */
  | { readonly type: 'tool_call_delta'; readonly id: string; readonly argumentsDelta: string }
  /**
   * The call, complete and parsed.
   *
   * Parsed here rather than by every caller: providers differ in how they
   * escape JSON strings, and a consumer that string-matched the raw fragments
   * would break on a Unicode or forward-slash escape it had never seen.
   */
  | {
      readonly type: 'tool_call_end'
      readonly id: string
      readonly name: string
      readonly arguments: Record<string, unknown>
    }
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
