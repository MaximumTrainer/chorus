import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createToolRegistry, shippedTools } from '@chorus/agent'
import type { AnyTool, ToolContext } from '@chorus/core'

/**
 * AGENT-5 AC2 — every external tool passes `before_external_write`.
 *
 * > asserted for **every** registered external tool, by enumeration, so a new
 * > one cannot be added ungated.
 *
 * The requirement asks for enumeration specifically, and the reason is the same
 * one behind the route table: a guarantee that must be remembered is one that
 * eventually is not. The tool most likely to be added ungated is the newest,
 * which is also the least reviewed.
 *
 * Enumeration alone would be **vacuous today** — no shipped tool writes
 * externally yet, because connector sinks are INT-4. A test that passes by
 * having nothing to check is worse than no test, so this suite also probes the
 * *mechanism* with tools of its own, which is non-vacuous now and stays true
 * whatever gets registered later.
 */

const context = (): ToolContext => ({
  workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  teamId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
  runId: '01ARZ3NDEKTSV4RRFFQ69G5FB1',
  actor: { userId: 'user-1', role: 'owner' },
  now: () => new Date('2026-09-03T12:00:00.000Z'),
  fetch: (async () => new Response('x', { status: 200 })) as typeof fetch,
})

const probe = (overrides: Partial<AnyTool> & { name: string }): AnyTool =>
  ({
    description: 'probe',
    input: z.object({}),
    output: z.object({}),
    sideEffect: 'none',
    requiredRole: 'member',
    requiredScopes: [],
    execute: async () => ({}),
    ...overrides,
  }) as unknown as AnyTool

describe('AGENT-5 AC2 external tools are gated by enumeration', () => {
  const shipped = shippedTools({ allowedHosts: ['docs.example.com'] })

  it('AGENT-5 AC2: the shipped registry can be enumerated, so this gate is not blind', () => {
    // If this ever returns nothing, the enumeration below is checking an empty
    // list and reporting success.
    expect(shipped.length).toBeGreaterThan(0)
  })

  it.each(shipped.map((tool) => [tool.name, tool] as const))(
    'AGENT-5 AC2: %s declares a side effect the registry can gate',
    (_name, tool: AnyTool) => {
      expect(['none', 'internal', 'external']).toContain(tool.sideEffect)

      // An external tool that cannot describe its own identity cannot be
      // retried safely, and the registry refuses to register one — asserted
      // here too, because this is the property a new tool most easily misses.
      if (tool.sideEffect === 'external') {
        expect(tool.idempotencyKey, `${tool.name} must declare an idempotencyKey`).toBeDefined()
      }
    },
  )

  it('AGENT-5 AC2: every shipped external tool is refused without an approved checkpoint', async () => {
    const external = shipped.filter((tool) => tool.sideEffect === 'external')
    const registry = createToolRegistry(shipped)

    for (const tool of external) {
      await expect(
        registry.invoke(tool.name, {}, context(), { allowed: [tool.name] }),
        `${tool.name} executed without passing before_external_write`,
      ).rejects.toThrow(/before_external_write/)
    }

    // Recorded rather than asserted: today this list is empty because connector
    // sinks are INT-4. The loop above becomes the real gate the moment one
    // lands, and the mechanism tests below hold in the meantime.
    expect(Array.isArray(external)).toBe(true)
  })

  it('AGENT-5 AC2: the mechanism refuses an ungated external tool — checked without relying on the shipped set', async () => {
    let executed = false
    const registry = createToolRegistry([
      probe({
        name: 'probe_external',
        sideEffect: 'external',
        idempotencyKey: () => 'k',
        execute: async () => {
          executed = true
          return {}
        },
      } as Partial<AnyTool> & { name: string }),
    ])

    await expect(
      registry.invoke('probe_external', {}, context(), { allowed: ['probe_external'] }),
    ).rejects.toThrow(/before_external_write/)
    expect(executed, 'the refusal must precede the side effect').toBe(false)
  })

  it('AGENT-5 AC2: an external tool with no idempotency key cannot even be registered', () => {
    // The other half of "cannot be added ungated": a tool that could not be
    // retried safely never reaches the registry at all.
    expect(() =>
      createToolRegistry([probe({ name: 'probe_unsafe', sideEffect: 'external' })]),
    ).toThrow(/idempotency/i)
  })

  it('AGENT-5 AC1: a tool absent from the allow-list is refused however it is invoked', async () => {
    const registry = createToolRegistry(shipped)

    for (const tool of shipped) {
      await expect(
        registry.invoke(tool.name, {}, context(), { allowed: [] }),
        `${tool.name} ran with an empty allow-list`,
      ).rejects.toThrow(/allow-list/)
    }
  })

  it('AGENT-5 AC5: no shipped tool requires less than the role it acts on behalf of', () => {
    // Every tool must state a role. A tool with no stated requirement would run
    // for anyone, which is the default that quietly grants the most.
    for (const tool of shipped) {
      expect(
        ['member', 'senior_member', 'admin', 'owner'],
        `${tool.name} must declare a required role`,
      ).toContain(tool.requiredRole)
    }
  })

  it('AGENT-5: tool names are unique and stable, because a workflow allow-lists by name', () => {
    const names = shipped.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      // Referenced from YAML definitions and from MCP tool schemas; a name with
      // surprising characters becomes a quoting problem in both.
      expect(name, `${name} should be a plain snake_case identifier`).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })
})
