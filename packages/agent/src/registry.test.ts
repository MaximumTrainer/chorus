import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type { Tool, ToolContext } from '@chorus/core'
import { createToolRegistry, ToolRefusedError } from './registry.js'

/**
 * AGENT-5 — the typed tool registry.
 *
 * The registry is where an agent's blast radius is decided. Every assertion
 * here is about something being *refused*, because a tool that runs when it
 * should not is the failure mode with consequences outside the system: an issue
 * created in someone's tracker, a message posted to their channel, a pull
 * request opened on their repository.
 *
 * The design principle running through all of it: an agent is not a privileged
 * actor. It acts for a person, with exactly that person's authority, through a
 * list of tools its workflow declared in advance.
 */

const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  teamId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
  runId: '01ARZ3NDEKTSV4RRFFQ69G5FB1',
  actor: { userId: 'user-1', role: 'senior_member' },
  now: () => new Date('2026-09-03T12:00:00.000Z'),
  ...overrides,
})

function tool<I, O>(overrides: Partial<Tool<I, O>> & Pick<Tool<I, O>, 'name'>): Tool<I, O> {
  return {
    description: 'a tool',
    input: z.object({ value: z.string() }) as unknown as z.ZodType<I>,
    output: z.object({ ok: z.boolean() }) as unknown as z.ZodType<O>,
    sideEffect: 'none',
    requiredRole: 'member',
    requiredScopes: [],
    execute: async () => ({ ok: true }) as unknown as O,
    ...overrides,
  }
}

describe('AGENT-5 tool registry', () => {
  it('AGENT-5 AC1: a tool the workflow did not allow is refused before it executes', async () => {
    let executed = false
    const registry = createToolRegistry([
      tool({ name: 'search_code', execute: async () => {
        executed = true
        return { ok: true }
      } }),
    ])

    await expect(
      registry.invoke('search_code', { value: 'x' }, context(), { allowed: ['retrieve'] }),
    ).rejects.toBeInstanceOf(ToolRefusedError)

    // Before, not during: a refusal that happens after the side effect is not a
    // refusal.
    expect(executed).toBe(false)
  })

  it('AGENT-5 AC1: the refusal names the tool and the allow-list', async () => {
    const registry = createToolRegistry([tool({ name: 'post_message' })])

    // A workflow author debugging this needs to know which tool and which list,
    // or the error sends them reading YAML by eye.
    await expect(
      registry.invoke('post_message', { value: 'x' }, context(), { allowed: ['retrieve'] }),
    ).rejects.toThrow(/post_message/)
  })

  it('AGENT-5: an unregistered tool is refused, even when the allow-list names it', async () => {
    // A workflow allow-listing a tool that does not exist is a definition bug,
    // and treating the allow-list as sufficient would run nothing and report
    // success.
    const registry = createToolRegistry([tool({ name: 'retrieve' })])

    await expect(
      registry.invoke('invented_tool', { value: 'x' }, context(), { allowed: ['invented_tool'] }),
    ).rejects.toThrow(/not registered/i)
  })

  it('AGENT-5 AC2: an external tool is refused without an approved checkpoint', async () => {
    let executed = false
    const registry = createToolRegistry([
      tool({
        name: 'create_issue',
        sideEffect: 'external',
        idempotencyKey: () => 'k',
        execute: async () => {
          executed = true
          return { ok: true }
        },
      }),
    ])

    await expect(
      registry.invoke('create_issue', { value: 'x' }, context(), { allowed: ['create_issue'] }),
    ).rejects.toThrow(/before_external_write/)
    expect(executed).toBe(false)
  })

  it('AGENT-5 AC2: an approved checkpoint lets the external tool through', async () => {
    const registry = createToolRegistry([
      tool({ name: 'create_issue', sideEffect: 'external', idempotencyKey: () => 'k' }),
    ])

    const result = await registry.invoke('create_issue', { value: 'x' }, context(), {
      allowed: ['create_issue'],
      externalWriteApproved: true,
    })
    expect(result).toEqual({ ok: true })
  })

  it('AGENT-5 AC2: internal and read-only tools need no checkpoint', async () => {
    // Gating everything would train people to approve without reading, which is
    // worse than gating nothing.
    const registry = createToolRegistry([
      tool({ name: 'retrieve', sideEffect: 'none' }),
      tool({ name: 'create_task', sideEffect: 'internal' }),
    ])

    await expect(
      registry.invoke('retrieve', { value: 'x' }, context(), { allowed: ['retrieve'] }),
    ).resolves.toEqual({ ok: true })
    await expect(
      registry.invoke('create_task', { value: 'x' }, context(), { allowed: ['create_task'] }),
    ).resolves.toEqual({ ok: true })
  })

  it('AGENT-5 AC2: registering an external tool without an idempotency key is refused', async () => {
    // At registration, not at invocation. An external tool that cannot describe
    // its own identity cannot be retried safely, and discovering that during an
    // incident is discovering it too late.
    expect(() =>
      createToolRegistry([tool({ name: 'post_message', sideEffect: 'external' })]),
    ).toThrow(/idempotency/i)
  })

  it('AGENT-5 AC3: malformed input from a model is refused with no side effect', async () => {
    let executed = false
    const registry = createToolRegistry([
      tool({
        name: 'create_task',
        sideEffect: 'internal',
        execute: async () => {
          executed = true
          return { ok: true }
        },
      }),
    ])

    // A model will eventually produce this. The boundary validates rather than
    // trusting, and names the field so the failure is actionable.
    await expect(
      registry.invoke('create_task', { value: 42 }, context(), { allowed: ['create_task'] }),
    ).rejects.toThrow(/value/)
    expect(executed).toBe(false)
  })

  it('AGENT-5 AC3: a tool returning the wrong shape fails at the tool, not three steps later', async () => {
    const registry = createToolRegistry([
      tool({ name: 'retrieve', execute: async () => ({ wrong: 'shape' }) as never }),
    ])

    await expect(
      registry.invoke('retrieve', { value: 'x' }, context(), { allowed: ['retrieve'] }),
    ).rejects.toThrow(/retrieve/)
  })

  it('AGENT-5 AC5: a tool is refused an operation the actor could not perform', async () => {
    let executed = false
    const registry = createToolRegistry([
      tool({
        name: 'start_job',
        requiredRole: 'senior_member',
        execute: async () => {
          executed = true
          return { ok: true }
        },
      }),
    ])

    // "Ask the agent to do it" must not be a privilege-escalation path that
    // looks like a feature.
    await expect(
      registry.invoke('start_job', { value: 'x' }, context({ actor: { userId: 'u', role: 'member' } }), {
        allowed: ['start_job'],
      }),
    ).rejects.toThrow(/senior_member/)
    expect(executed).toBe(false)
  })

  it('AGENT-5 AC5: the same tool runs for an actor who does hold the role', async () => {
    const registry = createToolRegistry([tool({ name: 'start_job', requiredRole: 'senior_member' })])

    await expect(
      registry.invoke('start_job', { value: 'x' }, context({ actor: { userId: 'u', role: 'admin' } }), {
        allowed: ['start_job'],
      }),
    ).resolves.toEqual({ ok: true })
  })

  it('AGENT-5 AC4: a repeated invocation with the same key does not run twice', async () => {
    let calls = 0
    const registry = createToolRegistry([
      tool({
        name: 'create_issue',
        sideEffect: 'external',
        idempotencyKey: (input) => `issue:${(input as { value: string }).value}`,
        execute: async () => {
          calls += 1
          return { ok: true }
        },
      }),
    ])

    const options = { allowed: ['create_issue'], externalWriteApproved: true }
    const first = await registry.invoke('create_issue', { value: 'a' }, context(), options)
    const second = await registry.invoke('create_issue', { value: 'a' }, context(), options)

    // A retried step must not open a second pull request. The second call
    // returns the first result rather than failing, because from the caller's
    // point of view the work is done.
    expect(calls).toBe(1)
    expect(second).toEqual(first)
  })

  it('AGENT-5 AC4: different inputs are different work', async () => {
    let calls = 0
    const registry = createToolRegistry([
      tool({
        name: 'create_issue',
        sideEffect: 'external',
        idempotencyKey: (input) => `issue:${(input as { value: string }).value}`,
        execute: async () => {
          calls += 1
          return { ok: true }
        },
      }),
    ])

    const options = { allowed: ['create_issue'], externalWriteApproved: true }
    await registry.invoke('create_issue', { value: 'a' }, context(), options)
    await registry.invoke('create_issue', { value: 'b' }, context(), options)
    expect(calls).toBe(2)
  })

  it('AGENT-5 AC4: idempotency is scoped to the run, not global', async () => {
    // Two runs legitimately doing the same thing must both do it. Collapsing
    // them would make a re-run of a workflow silently a no-op.
    let calls = 0
    const registry = createToolRegistry([
      tool({
        name: 'create_issue',
        sideEffect: 'external',
        idempotencyKey: () => 'same',
        execute: async () => {
          calls += 1
          return { ok: true }
        },
      }),
    ])

    const options = { allowed: ['create_issue'], externalWriteApproved: true }
    await registry.invoke('create_issue', { value: 'a' }, context({ runId: 'run-1' }), options)
    await registry.invoke('create_issue', { value: 'a' }, context({ runId: 'run-2' }), options)
    expect(calls).toBe(2)
  })

  it('AGENT-5: a duplicate registration is refused rather than silently replacing', async () => {
    // Two tools with one name means whichever loaded last wins, and which one
    // that is depends on import order.
    expect(() =>
      createToolRegistry([tool({ name: 'retrieve' }), tool({ name: 'retrieve' })]),
    ).toThrow(/retrieve/)
  })

  it('AGENT-5: the registry can be enumerated, which is what makes the NFR gate possible', () => {
    const registry = createToolRegistry([
      tool({ name: 'retrieve' }),
      tool({ name: 'create_issue', sideEffect: 'external', idempotencyKey: () => 'k' }),
    ])

    expect(registry.list().map((t) => t.name).sort()).toEqual(['create_issue', 'retrieve'])
    expect(registry.list().filter((t) => t.sideEffect === 'external')).toHaveLength(1)
  })

  it('AGENT-5: a tool receives tenancy and the run, and no way to reach the database', async () => {
    let seen: ToolContext | undefined
    const registry = createToolRegistry([
      tool({
        name: 'retrieve',
        execute: async (_input, ctx) => {
          seen = ctx
          return { ok: true }
        },
      }),
    ])

    await registry.invoke('retrieve', { value: 'x' }, context(), { allowed: ['retrieve'] })

    // The whole surface. Anything more would let a tool act outside the run it
    // belongs to, and a tool is the part of the system a model steers.
    expect(Object.keys(seen as object).sort()).toEqual([
      'actor',
      'now',
      'runId',
      'teamId',
      'workspaceId',
    ])
  })
})
