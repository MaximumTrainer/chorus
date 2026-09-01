import { describe, it, expect } from 'vitest'
import {
  createRouter,
  ModelCapabilityError,
  type RouterConfig,
  type Purpose,
} from '../../src/index.js'

/**
 * NFR-2 — Model agnosticism.
 *
 * Callers name a *purpose*, never a model. The router resolves purpose → tier →
 * concrete provider and model from workspace configuration, and refuses a model
 * that cannot meet the request's requirements rather than failing obscurely at
 * the provider (AC3).
 */

const config: RouterConfig = {
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
  tiers: {
    fast: [
      {
        ref: { provider: 'local', model: 'tiny' },
        capabilities: {
          structuredOutput: false,
          toolCalling: false,
          streaming: true,
          contextWindow: 8_000,
          embedding: false,
        },
        cost: { inputPerMillion: 0, outputPerMillion: 0 },
      },
      {
        ref: { provider: 'local', model: 'small-structured' },
        capabilities: {
          structuredOutput: true,
          toolCalling: true,
          streaming: true,
          contextWindow: 32_000,
          embedding: false,
        },
        cost: { inputPerMillion: 10, outputPerMillion: 30 },
      },
    ],
    balanced: [
      {
        ref: { provider: 'local', model: 'mid' },
        capabilities: {
          structuredOutput: true,
          toolCalling: true,
          streaming: true,
          contextWindow: 128_000,
          embedding: false,
        },
        cost: { inputPerMillion: 300, outputPerMillion: 1500 },
      },
    ],
    strong: [
      {
        ref: { provider: 'local', model: 'big' },
        capabilities: {
          structuredOutput: true,
          toolCalling: true,
          streaming: true,
          contextWindow: 200_000,
          embedding: false,
        },
        cost: { inputPerMillion: 300, outputPerMillion: 1500 },
      },
    ],
  },
}

describe('NFR-2 model router', () => {
  const router = createRouter(config)

  it('NFR-2: a purpose resolves to the tier configured for it, and the caller never names a model', () => {
    expect(router.resolve({ purpose: 'classify', requires: {} }).chosen.ref).toEqual({
      provider: 'local',
      model: 'tiny',
    })
    expect(router.resolve({ purpose: 'code', requires: {} }).chosen.ref.model).toBe('big')
  })

  it('NFR-2 AC3: a capability the first candidate lacks falls back within the tier, and records it', () => {
    const decision = router.resolve({ purpose: 'classify', requires: { structuredOutput: true } })

    expect(decision.chosen.ref.model).toBe('small-structured')
    expect(decision.fellBackFrom).toEqual([
      { ref: { provider: 'local', model: 'tiny' }, missing: ['structuredOutput'] },
    ])
  })

  it('NFR-2 AC3: no fallback is recorded when the preferred candidate is used', () => {
    expect(router.resolve({ purpose: 'classify', requires: {} }).fellBackFrom).toEqual([])
  })

  it('NFR-2 AC3: a request no model in the tier can serve fails with a named capability, not obscurely', () => {
    expect(() =>
      router.resolve({ purpose: 'chat', requires: { contextWindowTokens: 1_000_000 } }),
    ).toThrow(ModelCapabilityError)

    try {
      router.resolve({ purpose: 'chat', requires: { contextWindowTokens: 1_000_000 } })
    } catch (error) {
      expect((error as ModelCapabilityError).message).toContain('contextWindow')
      expect((error as ModelCapabilityError).tier).toBe('balanced')
    }
  })

  it('NFR-2: every purpose is routable, so no caller can hit an unconfigured path', () => {
    const purposes: Purpose[] = [
      'chat',
      'classify',
      'extract',
      'draft',
      'decompose',
      'code',
      'summarise',
      'embed',
    ]
    for (const purpose of purposes) {
      expect(() => router.resolve({ purpose, requires: {} }), purpose).not.toThrow()
    }
  })

  it('NFR-8: cost is computed from the resolved candidate, in whole cents of a currency-free unit', () => {
    const decision = router.resolve({ purpose: 'chat', requires: {} })
    // 1M in, 1M out at 300/1500 per million.
    expect(router.costCents(decision.chosen, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(
      1800,
    )
  })

  it('NFR-8: a free local model costs nothing, so self-hosters are not billed by arithmetic', () => {
    const decision = router.resolve({ purpose: 'classify', requires: {} })
    expect(router.costCents(decision.chosen, { inputTokens: 5_000, outputTokens: 5_000 })).toBe(0)
  })
})
