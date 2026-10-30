import { describe, it, expect } from 'vitest'
import { RateLimitedError, ValidationError } from '@chorus/core'
import type { ConnectorContext, ExternalRef, SinkAction } from './contract.js'
import { runSinkAction, runSinkBatch } from './sink-runner.js'

/**
 * INT-4 AC4 — bulk sink operations report per-item outcomes.
 *
 * A push of several items is the common case, and the failure that matters is
 * the partial one: some items land, some do not. The batch must say which did
 * which, must not roll back the ones that succeeded, and — because each item
 * carries its own idempotency key — must not duplicate them when the batch is
 * retried. Error classification rides along: a rate limit is retryable, a
 * validation failure is not.
 */

const ctx = {} as ConnectorContext

/**
 * A scripted create action with an in-memory store, like a tiny real sink.
 * `find` dedupes by key (search-before-create), and inputs can be told to fail.
 */
function scriptedAction(options: {
  failRetryable?: ReadonlySet<string>
  failPermanent?: ReadonlySet<string>
}): SinkAction<{ id: string }> {
  const store = new Map<string, ExternalRef>()
  let n = 0
  return {
    name: 'create_thing',
    sideEffect: 'external',
    async find(key) {
      return store.get(key) ?? null
    },
    async execute(input, key) {
      if (options.failRetryable?.has(input.id)) {
        throw new RateLimitedError('slow down', { retryAfterMs: 1000 })
      }
      if (options.failPermanent?.has(input.id)) {
        throw new ValidationError('that input is invalid', { field: 'id' })
      }
      const ref: ExternalRef = { externalId: `obj-${(n += 1)}`, url: `https://x.test/${input.id}` }
      store.set(key, ref)
      return ref
    },
  }
}

const items = (...ids: string[]) => ids.map((id) => ({ idempotencyKey: `k-${id}`, input: { id } }))

describe('INT-4 runSinkBatch', () => {
  it('INT-4 AC4: reports a per-item outcome for every item, in order', async () => {
    const action = scriptedAction({ failPermanent: new Set(['b']) })

    const outcomes = await runSinkBatch(action, items('a', 'b', 'c'), ctx)

    expect(outcomes).toHaveLength(3)
    expect(outcomes[0]).toMatchObject({ status: 'ok' })
    expect(outcomes[1]).toMatchObject({ status: 'failed', retryable: false })
    expect(outcomes[2]).toMatchObject({ status: 'ok' })
  })

  it('INT-4 AC4: classifies a rate limit as retryable and a validation failure as not', async () => {
    const action = scriptedAction({ failRetryable: new Set(['a']), failPermanent: new Set(['b']) })

    const [a, b] = await runSinkBatch(action, items('a', 'b'), ctx)

    expect(a).toMatchObject({ status: 'failed', retryable: true })
    expect(b).toMatchObject({ status: 'failed', retryable: false })
  })

  it('INT-4 AC4: a retry of the batch does not duplicate the items that already succeeded', async () => {
    // First pass: 'b' fails, 'a' and 'c' land.
    const action = scriptedAction({ failPermanent: new Set(['b']) })
    const first = await runSinkBatch(action, items('a', 'b', 'c'), ctx)
    const landed = first.flatMap((o) => (o.status === 'ok' ? [o.ref.externalId] : []))
    expect(landed).toHaveLength(2)

    // Retry the whole batch: the ones that succeeded resolve to the same
    // objects (find dedupes), not new ones.
    const again = await runSinkBatch(action, items('a', 'b', 'c'), ctx)
    expect(again[0]).toMatchObject({ status: 'ok', ref: { externalId: landed[0] } })
    expect(again[2]).toMatchObject({ status: 'ok', ref: { externalId: landed[1] } })
  })

  it('INT-4 AC4: a successful item is reachable through runSinkAction afterwards too', async () => {
    const action = scriptedAction({})
    await runSinkBatch(action, items('a'), ctx)
    // The single-item path sees the same stored object.
    const ref = await runSinkAction(action, { id: 'a' }, 'k-a', ctx)
    expect(ref.externalId).toBe('obj-1')
  })
})
