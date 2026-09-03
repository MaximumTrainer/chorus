import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node'
import type { SpanExporter } from '@opentelemetry/sdk-trace-node'

/**
 * A span collector for tests (NFR-5, CLAUDE.md §4).
 *
 * Shipped from this package rather than assembled per suite, for the same
 * reason the tracing SDK may only be imported here: instrumentation spreads
 * faster than any other dependency because every call site is a plausible place
 * for a span, and a test that reaches for `InMemorySpanExporter` is the first
 * step of exactly that spread. The dependency-boundary check enforces it, and
 * caught this file's absence.
 *
 * It also makes the *assertion* vocabulary ours. A suite asserting on
 * `parentSpanContext?.spanId` is coupled to an SDK internal that has already
 * been renamed once; `CollectedSpan` is the shape we mean, and a future SDK
 * change is one edit here rather than one per suite.
 */

export interface CollectedSpan {
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  /** Absent for a root span, which is how a root is identified. */
  readonly parentSpanId?: string
  readonly attributes: Readonly<Record<string, unknown>>
  /** Milliseconds since the epoch, so a test can compare against `Date.now()`. */
  readonly startedAtMs: number
  readonly endedAtMs: number
}

export interface SpanCollector {
  /** Passed to `initTelemetry` as its exporter. */
  readonly exporter: SpanExporter
  collected(): readonly CollectedSpan[]
  /** The one span with no parent, when there is exactly one. */
  root(): CollectedSpan | undefined
  childrenOf(span: CollectedSpan): readonly CollectedSpan[]
  reset(): void
}

const toMs = (time: readonly [number, number]): number => time[0] * 1000 + time[1] / 1e6

export function createSpanCollector(): SpanCollector {
  const exporter = new InMemorySpanExporter()

  const collected = (): CollectedSpan[] =>
    exporter.getFinishedSpans().map((span) => {
      const parent = span.parentSpanContext?.spanId
      return {
        name: span.name,
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        ...(parent ? { parentSpanId: parent } : {}),
        attributes: span.attributes,
        startedAtMs: toMs(span.startTime),
        endedAtMs: toMs(span.endTime),
      }
    })

  return {
    exporter,
    collected,
    root: () => collected().find((span) => span.parentSpanId === undefined),
    childrenOf: (span) => collected().filter((other) => other.parentSpanId === span.spanId),
    reset: () => {
      exporter.reset()
    },
  }
}
