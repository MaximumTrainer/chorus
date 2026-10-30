import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type { ExternalRef, SinkDispatch, SinkDispatcher, ToolContext } from '@chorus/core'
import { createToolRegistry } from '../registry.js'
import { createSinkTool, trackerSinkTools } from './sink.js'

/**
 * INT-4 — a connector sink tool, at the agent seam.
 *
 * The tool writes nothing itself: it validates, derives an idempotency key, and
 * hands the write to the dispatcher on its context. These prove the seam — the
 * write is refused without the external-write checkpoint (AC1), and when it does
 * run it reaches the dispatcher with a key stable across a retry (AC2), so a
 * connector's search-before-create can collapse a duplicate.
 */

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    teamId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
    runId: 'run-1',
    actor: { userId: 'user-1', role: 'owner' },
    now: () => new Date('2026-09-03T12:00:00.000Z'),
    ...overrides,
  }
}

/** A dispatcher that records what it was asked to write and answers with a ref. */
function recordingDispatcher(): SinkDispatcher & { calls: SinkDispatch[] } {
  const calls: SinkDispatch[] = []
  return {
    calls,
    async dispatch(request: SinkDispatch): Promise<ExternalRef> {
      calls.push(request)
      return { externalId: 'ext-1', url: 'https://tracker.test/ext-1' }
    },
  }
}

describe('INT-4 connector sink tool', () => {
  const createIssue = createSinkTool({
    name: 'create_issue',
    description: 'create an issue',
    input: z.object({ title: z.string().min(1) }),
    requiredRole: 'member',
    requiredScopes: ['write:artefacts'],
  })

  it('INT-4: is an external write with an idempotency key', () => {
    expect(createIssue.sideEffect).toBe('external')
    expect(createIssue.idempotencyKey).toBeDefined()
  })

  it('INT-4 AC1: the registry refuses it without an approved external-write checkpoint', async () => {
    const registry = createToolRegistry([createIssue as never])
    await expect(
      registry.invoke('create_issue', { title: 'x' }, context({ sinkDispatcher: recordingDispatcher() }), {
        allowed: ['create_issue'],
      }),
    ).rejects.toThrow(/before_external_write/)
  })

  it('INT-4 AC1: with the checkpoint passed it dispatches the write', async () => {
    const dispatcher = recordingDispatcher()
    const registry = createToolRegistry([createIssue as never])

    const ref = await registry.invoke<ExternalRef>(
      'create_issue',
      { title: 'The deploy step times out' },
      context({ sinkDispatcher: dispatcher }),
      { allowed: ['create_issue'], externalWriteApproved: true },
    )

    expect(ref.externalId).toBe('ext-1')
    expect(dispatcher.calls).toHaveLength(1)
    expect(dispatcher.calls[0]).toMatchObject({ action: 'create_issue' })
    expect(dispatcher.calls[0]!.idempotencyKey, 'the write carries a run-scoped key').toContain('run-1:')
  })

  it('INT-4 AC2: a retried write in one run collapses to a single dispatch', async () => {
    const dispatcher = recordingDispatcher()
    const ctx = context({ sinkDispatcher: dispatcher })
    const registry = createToolRegistry([createIssue as never])
    const run = () =>
      registry.invoke<ExternalRef>('create_issue', { title: 'same title' }, ctx, {
        allowed: ['create_issue'],
        externalWriteApproved: true,
      })

    const first = await run()
    const again = await run()

    // Same run, same input, same derived key: the registry returns the first
    // result and the write reaches the connector once, not twice.
    expect(again.externalId).toBe(first.externalId)
    expect(dispatcher.calls, 'a retried write must not reach the connector twice').toHaveLength(1)
  })

  it('INT-4 AC2: the idempotency key is a function of the input alone', () => {
    const key = (title: string) => createIssue.idempotencyKey!({ title })
    expect(key('same'), 'the same input derives the same key').toBe(key('same'))
    expect(key('a'), 'different inputs derive different keys').not.toBe(key('b'))
  })

  it('INT-4: a tool with no dispatcher wired refuses rather than silently doing nothing', async () => {
    const registry = createToolRegistry([createIssue as never])
    await expect(
      registry.invoke('create_issue', { title: 'x' }, context(), {
        allowed: ['create_issue'],
        externalWriteApproved: true,
      }),
    ).rejects.toThrow(/dispatcher/i)
  })

  it('INT-4: the shipped tracker set is the catalogue’s actions, each external', () => {
    const names = trackerSinkTools().map((tool) => tool.name).sort()
    expect(names).toEqual(['comment_issue', 'create_issue', 'transition_issue', 'update_issue'])
    for (const tool of trackerSinkTools()) {
      expect(tool.sideEffect).toBe('external')
      expect(tool.idempotencyKey).toBeDefined()
    }
  })
})
