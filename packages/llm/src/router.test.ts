import { describe, it, expect } from 'vitest'
import { missingCapabilities, createRouter, ModelCapabilityError } from './router.js'
import type { ModelCandidate, RouterConfig } from './types.js'

const candidate = (overrides: Partial<ModelCandidate['capabilities']> = {}): ModelCandidate => ({
  ref: { provider: 'test', model: 'm' },
  capabilities: {
    structuredOutput: true,
    toolCalling: true,
    streaming: true,
    streamingToolDeltas: true,
    contextWindow: 100_000,
    embedding: false,
    ...overrides,
  },
  cost: { inputPerMillion: 100, outputPerMillion: 200 },
})

describe('NFR-2 capability matching', () => {
  it('NFR-2: a candidate meeting every requirement is missing nothing', () => {
    expect(missingCapabilities(candidate(), { structuredOutput: true, toolCalling: true })).toEqual([])
  })

  it('NFR-2: absent requirements mean "do not care", not "must be false"', () => {
    expect(missingCapabilities(candidate({ toolCalling: false }), {})).toEqual([])
  })

  it('NFR-2: each unmet capability is named individually', () => {
    const missing = missingCapabilities(
      candidate({ structuredOutput: false, toolCalling: false }),
      { structuredOutput: true, toolCalling: true },
    )
    expect(missing).toEqual(['structuredOutput', 'toolCalling'])
  })

  it('NFR-2 AC3: an undersized context window reports both the need and what is available', () => {
    const [message] = missingCapabilities(candidate({ contextWindow: 8_000 }), {
      contextWindowTokens: 32_000,
    })
    expect(message).toContain('needs 32000')
    expect(message).toContain('has 8000')
  })

  it('NFR-2: a context window exactly equal to the requirement is sufficient', () => {
    expect(
      missingCapabilities(candidate({ contextWindow: 32_000 }), { contextWindowTokens: 32_000 }),
    ).toEqual([])
  })

  it('NFR-2: streaming tool deltas are distinct from streaming text', () => {
    expect(
      missingCapabilities(candidate({ streamingToolDeltas: false }), { streamingToolDeltas: true }),
    ).toEqual(['streamingToolDeltas'])
    expect(
      missingCapabilities(candidate({ streamingToolDeltas: false }), { streaming: true }),
    ).toEqual([])
  })
})

describe('NFR-2 router configuration failures', () => {
  const bare = (tiers: RouterConfig['tiers']): RouterConfig => ({
    purposeToTier: {
      chat: 'balanced',
      classify: 'fast',
      extract: 'fast',
      draft: 'balanced',
      decompose: 'balanced',
      code: 'strong',
      summarise: 'fast',
      embed: 'fast',
    },
    tiers,
  })

  it('NFR-2: an empty tier fails at resolution with the tier named, not with an undefined read', () => {
    const router = createRouter(bare({ fast: [], balanced: [], strong: [] }))
    expect(() => router.resolve({ purpose: 'chat', requires: {} })).toThrow(/Tier "balanced"/)
  })

  it('NFR-2 AC3: the failure lists every candidate considered and what each lacked', () => {
    const router = createRouter(
      bare({
        fast: [candidate({ structuredOutput: false }), candidate({ structuredOutput: false })],
        balanced: [],
        strong: [],
      }),
    )
    try {
      router.resolve({ purpose: 'classify', requires: { structuredOutput: true } })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ModelCapabilityError)
      expect((error as ModelCapabilityError).details.candidates).toHaveLength(2)
    }
  })
})

describe('NFR-8 cost accounting', () => {
  const router = createRouter({
    purposeToTier: {
      chat: 'balanced',
      classify: 'fast',
      extract: 'fast',
      draft: 'balanced',
      decompose: 'balanced',
      code: 'strong',
      summarise: 'fast',
      embed: 'fast',
    },
    tiers: { fast: [candidate()], balanced: [candidate()], strong: [candidate()] },
  })

  it('NFR-8: zero usage costs zero', () => {
    expect(router.costCents(candidate(), { inputTokens: 0, outputTokens: 0 })).toBe(0)
  })

  it('NFR-8: cost is integer arithmetic, so displayed totals reconcile with the ledger exactly', () => {
    // Sub-cent usage rounds rather than accumulating float drift.
    const cost = router.costCents(candidate(), { inputTokens: 1, outputTokens: 1 })
    expect(Number.isInteger(cost)).toBe(true)
  })

  it('NFR-8: cost scales linearly with tokens', () => {
    const one = router.costCents(candidate(), { inputTokens: 1_000_000, outputTokens: 0 })
    const two = router.costCents(candidate(), { inputTokens: 2_000_000, outputTokens: 0 })
    expect(two).toBe(one * 2)
  })
})
