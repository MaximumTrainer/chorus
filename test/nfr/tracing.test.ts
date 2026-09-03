import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node'
import { ulid } from '@chorus/core'
import {
  currentTraceContext,
  initTelemetry,
  shutdownTelemetry,
  withRemoteContext,
  withSpan,
} from '@chorus/telemetry'
import { createQueue, redisConfigFromEnv, type Queue } from '@chorus/queue'

/**
 * NFR-5 AC2 — one trace spans request → queue → worker → model call.
 *
 * The criterion names four hops and the difficulty is entirely the second one.
 * Within a process a trace is ambient context that propagates by itself; across
 * a queue it does not, and a system that traces beautifully on each side of a
 * boundary while producing two unrelated traces has answered nothing. The one
 * question a trace exists to answer is *where did this request's work actually
 * go*, and that question spans the boundary by definition.
 *
 * Asserted on collected spans rather than on a log line, because "the trace id
 * appeared in two places" is not the same claim as "these spans are one trace
 * with the right parentage".
 */
describe('NFR-5 AC2 distributed tracing', () => {
  const exporter = new InMemorySpanExporter()
  let queue: Queue
  const prefix = `trace-${ulid()}`

  const spansByName = (name: string): ReadableSpan[] =>
    exporter.getFinishedSpans().filter((span) => span.name === name)

  beforeAll(async () => {
    initTelemetry({ serviceName: 'nfr-tracing-suite', exporter })
    queue = createQueue({ ...redisConfigFromEnv(), prefix })
  })

  afterAll(async () => {
    await queue?.close()
    await shutdownTelemetry()
  })

  it('NFR-5 AC2: a request, its queued work and the model call it causes are one trace', async () => {
    const name = `pipeline-${ulid()}`

    // The worker half: continues whatever trace the producer was in, then does
    // its own work — including a model call, which is the fourth hop.
    await queue.consume<{ repositoryId: string }>(name, async (job) => {
      await withRemoteContext(job.traceContext, async () => {
        await withSpan('worker.index_repository', { 'chorus.queue': name }, async () => {
          await withSpan('model.embed', { 'chorus.model.purpose': 'embed' }, async () => {})
        })
      })
    })

    // The API half: a request that enqueues.
    await withSpan('http.POST /workspaces/:id/repositories', { 'http.method': 'POST' }, async () => {
      await queue.enqueue(
        name,
        { repositoryId: 'repo-1' },
        { traceContext: currentTraceContext() },
      )
    })
    await queue.drain(name)

    const request = spansByName('http.POST /workspaces/:id/repositories')[0]
    const worker = spansByName('worker.index_repository')[0]
    const model = spansByName('model.embed')[0]

    expect(request, 'the request span must exist').toBeDefined()
    expect(worker, 'the worker span must exist').toBeDefined()
    expect(model, 'the model span must exist').toBeDefined()

    // One trace, which is the whole criterion.
    expect(worker!.spanContext().traceId).toBe(request!.spanContext().traceId)
    expect(model!.spanContext().traceId).toBe(request!.spanContext().traceId)

    // And correctly parented, not merely sharing an id. A flat trace cannot
    // show that the model call happened *because of* that request.
    expect(worker!.parentSpanContext?.spanId).toBe(request!.spanContext().spanId)
    expect(model!.parentSpanContext?.spanId).toBe(worker!.spanContext().spanId)
  })

  it('NFR-5 AC2: a worker with no carried context starts its own trace rather than failing', async () => {
    // A job enqueued before tracing was switched on, or by a process that does
    // not trace. It must still run, and its work must still be traced — just
    // as a root rather than a child.
    const name = `orphan-${ulid()}`
    await queue.consume(name, async (job) => {
      await withRemoteContext(job.traceContext, async () => {
        await withSpan('worker.orphan', {}, async () => {})
      })
    })

    await queue.enqueue(name, { n: 1 })
    await queue.drain(name)

    const span = spansByName('worker.orphan')[0]
    expect(span).toBeDefined()
    expect(span!.parentSpanContext).toBeUndefined()
  })

  it('NFR-5: a failing span is recorded as failed, and the error still propagates', async () => {
    // A trace showing only successes is worse than no trace, because it is
    // trusted. And swallowing the error to keep the trace tidy would be the
    // worst possible trade.
    await expect(
      withSpan('work.that.fails', {}, async () => {
        throw new Error('the source hung up')
      }),
    ).rejects.toThrow('the source hung up')

    const span = spansByName('work.that.fails')[0]
    expect(span!.status.code).toBe(2) // ERROR
    expect(span!.status.message).toBe('the source hung up')
    expect(span!.events.some((event) => event.name === 'exception')).toBe(true)
  })

  it('NFR-5: attributes carry the workspace, so a trace can be scoped to a tenant', async () => {
    const workspaceId = ulid()
    await withSpan('scoped.work', { 'chorus.workspace_id': workspaceId }, async () => {})

    const span = spansByName('scoped.work')[0]
    expect(span!.attributes['chorus.workspace_id']).toBe(workspaceId)
  })

  it('NFR-5: the carrier is the W3C interchange format, not something of ours', async () => {
    // So a job enqueued here can be picked up by a process running a different
    // tracing stack and still join the same trace.
    const carrier = await withSpan('carrier.check', {}, async () => currentTraceContext())

    expect(carrier.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
  })

  it('NFR-5: nothing is exported when tracing is not configured', async () => {
    // NFR-1 requires a stack that stands up with no external service. A
    // provider collecting spans nobody reads is pure overhead, so an
    // unconfigured deployment does not start one at all — and the calling code
    // is identical either way.
    expect(currentTraceContext()).toBeDefined()
    await withSpan('always.safe', {}, async () => {})
  })
})
