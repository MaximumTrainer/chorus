import {
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Span,
  type Tracer,
} from '@opentelemetry/api'
import { NodeTracerProvider, SimpleSpanProcessor, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node'
import type { SpanExporter } from '@opentelemetry/sdk-trace-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions'

/**
 * Tracing (NFR-5 AC2).
 *
 * **This is the only package that may import OpenTelemetry.** Every other
 * package takes a span through these three functions, so the instrumentation
 * vocabulary is ours and swapping the backend is one file — the same argument
 * as the queue's, and for the same reason: the alternative is an SDK's types
 * spreading through every call site until the choice is permanent.
 *
 * The criterion is "one trace spans request → queue → worker → model call", and
 * the whole difficulty is the queue. A trace is a process-local ambient context;
 * a queue is a boundary that context does not cross by itself. So it is carried
 * explicitly, as W3C `traceparent`, and re-established on the far side. Without
 * that a run appears as two unrelated traces and the one question the trace
 * exists to answer — *where did this request's work actually go* — has no answer.
 */

const TRACER_NAME = 'chorus'

let provider: NodeTracerProvider | undefined

export interface TelemetryOptions {
  readonly serviceName: string
  readonly serviceVersion?: string
  /**
   * OTLP endpoint. When absent, tracing is **fully disabled** rather than
   * exported nowhere: a provider collecting spans no one reads is pure overhead,
   * and NFR-1 requires a stack that stands up with no external service.
   */
  readonly endpoint?: string
  /** For tests: collects spans in memory rather than shipping them. */
  readonly exporter?: SpanExporter
}

/**
 * Starts tracing. Idempotent — a second call is ignored rather than replacing
 * the provider, because two providers means spans split between them.
 */
export function initTelemetry(options: TelemetryOptions): void {
  if (provider) return

  const endpoint = options.endpoint ?? process.env.CHORUS_OTLP_ENDPOINT
  if (!options.exporter && !endpoint) return

  const exporter = options.exporter ?? new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? '0.0.0',
    }),
    spanProcessors: [
      // Simple when a test supplied its exporter, so an assertion does not race
      // a batch timer; batched otherwise, because one HTTP request per span
      // would cost more than the work being traced.
      options.exporter
        ? new SimpleSpanProcessor(options.exporter)
        : new BatchSpanProcessor(exporter),
    ],
  })

  provider.register({ propagator: new W3CTraceContextPropagator() })
}

export async function shutdownTelemetry(): Promise<void> {
  await provider?.shutdown()
  provider = undefined
}

const tracer = (): Tracer => trace.getTracer(TRACER_NAME)

export type SpanAttributes = Readonly<Record<string, string | number | boolean>>

/**
 * Runs `fn` inside a span.
 *
 * A thrown error marks the span failed and is rethrown unchanged. Swallowing it
 * to keep the trace tidy would be the worst possible trade: a trace showing
 * only successes is worse than no trace, because it is trusted.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      })
      span.recordException(error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally {
      span.end()
    }
  })
}

/**
 * The current trace, as a carrier that survives serialisation.
 *
 * W3C `traceparent`, which is the interchange format every backend understands
 * — so a job enqueued by this process can be picked up by one running a
 * different tracing stack and still join the same trace.
 *
 * Empty when tracing is disabled, which makes the caller's code identical
 * either way.
 */
export function currentTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {}
  propagation.inject(context.active(), carrier)
  return carrier
}

/**
 * Continues a trace that started somewhere else.
 *
 * The far side of the queue. Spans created inside `fn` are children of whatever
 * created the carrier, so a worker's work appears under the request that caused
 * it rather than as an orphan.
 */
export async function withRemoteContext<T>(
  carrier: Readonly<Record<string, string>> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!carrier || Object.keys(carrier).length === 0) return fn()
  return context.with(propagation.extract(context.active(), carrier), fn)
}

/** The active trace id, for logs. Empty when tracing is disabled. */
export function currentTraceId(): string {
  return trace.getActiveSpan()?.spanContext().traceId ?? ''
}

export type { Span, SpanExporter }
