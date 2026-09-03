import { describe, it, expect } from 'vitest'
import { DEFAULT_PURPOSE_TIERS, routerConfigFromEnv, TIER_REQUIREMENTS } from './config.js'

/**
 * ADR-0015 — tier configuration.
 *
 * The ADR decides that a tier is a capability-and-cost contract rather than a
 * model, that concrete models are deployment configuration, and that a tier
 * with no configured candidate **fails at boot naming the tier**.
 *
 * That last one is the assertion that matters. A `strong` request quietly
 * served by `fast` is an invisible quality regression, and boot is the cheapest
 * moment to find a missing mapping — a first chat with a stack trace is the
 * most expensive.
 */

const valid = JSON.stringify({
  fast: [{ provider: 'openai-compatible', model: 'a-small-model', contextWindow: 32_000 }],
  balanced: [{ provider: 'openai-compatible', model: 'a-mid-model', contextWindow: 128_000 }],
  strong: [{ provider: 'openai-compatible', model: 'a-large-model', contextWindow: 200_000 }],
  embed: [{ provider: 'openai-compatible', model: 'an-embedding-model', embedding: true }],
})

describe('ADR-0015 tier configuration', () => {
  it('ADR-0015: a complete mapping produces a router config', () => {
    const config = routerConfigFromEnv({ CHORUS_MODEL_TIERS: valid })

    expect(config.tiers.fast[0]!.ref).toEqual({
      provider: 'openai-compatible',
      model: 'a-small-model',
    })
    expect(config.purposeToTier).toEqual(DEFAULT_PURPOSE_TIERS)
  })

  it('ADR-0015: a missing tier fails at boot, naming the tier', () => {
    const partial = JSON.stringify({
      fast: [{ provider: 'p', model: 'm', contextWindow: 32_000 }],
    })

    // Named, because "which tier is missing" is the whole diagnosis. A generic
    // "invalid configuration" sends an operator reading JSON by eye.
    expect(() => routerConfigFromEnv({ CHORUS_MODEL_TIERS: partial })).toThrow(/balanced/)
  })

  it('ADR-0015: an absent mapping fails rather than defaulting to a model', () => {
    // Defaulting would put a model name in this repository, which is exactly
    // what the boundary rule forbids and what makes a provider's deprecation
    // our release problem.
    expect(() => routerConfigFromEnv({})).toThrow(/CHORUS_MODEL_TIERS/)
  })

  it('ADR-0015: a tier configured with an empty list is a missing tier', () => {
    const empty = JSON.stringify({ fast: [], balanced: [], strong: [], embed: [] })
    expect(() => routerConfigFromEnv({ CHORUS_MODEL_TIERS: empty })).toThrow(/fast/)
  })

  it('ADR-0015: unparseable configuration says so, and does not half-apply', () => {
    expect(() => routerConfigFromEnv({ CHORUS_MODEL_TIERS: '{ not json' })).toThrow(
      /CHORUS_MODEL_TIERS/,
    )
  })

  it('ADR-0015: a candidate below its tier’s context window is refused at boot', () => {
    // The tier is a contract. A `strong` model with a 32k window cannot serve
    // what `strong` promises, and discovering that mid-run is a truncated
    // prompt and a wrong answer.
    const undersized = JSON.parse(valid) as Record<string, Array<Record<string, unknown>>>
    undersized.strong![0]!.contextWindow = 8_000

    expect(() =>
      routerConfigFromEnv({ CHORUS_MODEL_TIERS: JSON.stringify(undersized) }),
    ).toThrow(/strong/)
  })

  it('ADR-0015: the embedding tier must actually be an embedding model', () => {
    const wrong = JSON.parse(valid) as Record<string, Array<Record<string, unknown>>>
    wrong.embed![0]!.embedding = false

    // Embedding with a chat model produces vectors that are not comparable to
    // anything, so retrieval degrades to noise rather than failing.
    expect(() => routerConfigFromEnv({ CHORUS_MODEL_TIERS: JSON.stringify(wrong) })).toThrow(
      /embed/,
    )
  })

  it('ADR-0015: decompose and code sit at strong, deliberately', () => {
    // Both produce artefacts a person then works from — a task tree, a pull
    // request — so an error is not a bad sentence, it is an afternoon.
    expect(DEFAULT_PURPOSE_TIERS.decompose).toBe('strong')
    expect(DEFAULT_PURPOSE_TIERS.code).toBe('strong')
    expect(DEFAULT_PURPOSE_TIERS.classify).toBe('fast')
    expect(DEFAULT_PURPOSE_TIERS.chat).toBe('balanced')
  })

  it('ADR-0015: every tier states what a caller may rely on', () => {
    // The point of the contract: a prompt is written against these, so
    // re-pointing a tier at a different model must not re-tune the prompt.
    for (const tier of ['fast', 'balanced', 'strong'] as const) {
      expect(TIER_REQUIREMENTS[tier].structuredOutput).toBe(true)
      expect(TIER_REQUIREMENTS[tier].contextWindowTokens).toBeGreaterThan(0)
    }
    expect(TIER_REQUIREMENTS.balanced.toolCalling).toBe(true)
    expect(TIER_REQUIREMENTS.balanced.streaming).toBe(true)
  })

  it('ADR-0015: extra candidates in a tier are kept, in order, as fallbacks', () => {
    const withFallback = JSON.parse(valid) as Record<string, Array<Record<string, unknown>>>
    withFallback.balanced!.push({
      provider: 'openai-compatible',
      model: 'a-backup-model',
      contextWindow: 128_000,
    })

    const config = routerConfigFromEnv({ CHORUS_MODEL_TIERS: JSON.stringify(withFallback) })
    // Order is the preference, and the router records every fallback in the run
    // trace so a silent downgrade is impossible to miss (NFR-2 AC3).
    expect(config.tiers.balanced.map((c) => c.ref.model)).toEqual(['a-mid-model', 'a-backup-model'])
  })
})
