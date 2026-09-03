import { ConfigurationError } from '@chorus/core'
import type {
  CapabilityRequirements,
  ModelCandidate,
  Purpose,
  RouterConfig,
  Tier,
} from './types.js'

/**
 * Tier configuration (ADR-0015).
 *
 * A tier is a **capability-and-cost contract**, not a model. Prompts are written
 * against what a tier guarantees, so re-pointing a tier at a different model
 * must not require re-tuning a prompt — which is the cost `plan.md` §7 names for
 * getting this wrong.
 *
 * Concrete models are deployment configuration, never source. That is what keeps
 * the boundary rule "no model name outside `packages/llm`" meaningful, and it is
 * why a provider's deprecation — which happens on their schedule, not ours — is
 * an ops change rather than a release.
 */

/**
 * What a caller may rely on per tier.
 *
 * These are the promises a prompt is written against. Widening one is a
 * breaking change for every prompt that assumed the old floor.
 */
export const TIER_REQUIREMENTS: Readonly<Record<Tier, CapabilityRequirements>> = Object.freeze({
  fast: { structuredOutput: true, contextWindowTokens: 32_000 },
  balanced: {
    structuredOutput: true,
    toolCalling: true,
    streaming: true,
    contextWindowTokens: 128_000,
  },
  strong: {
    structuredOutput: true,
    toolCalling: true,
    streaming: true,
    contextWindowTokens: 200_000,
  },
})

/**
 * Which tier serves which purpose, by default and overridable per workspace.
 *
 * `decompose` and `code` sit at `strong` deliberately: both produce artefacts a
 * person then works from — a task tree, a pull request — so an error is not a
 * bad sentence, it is an afternoon.
 */
export const DEFAULT_PURPOSE_TIERS: Readonly<Record<Purpose, Tier>> = Object.freeze({
  classify: 'fast',
  extract: 'fast',
  chat: 'balanced',
  draft: 'balanced',
  summarise: 'balanced',
  decompose: 'strong',
  code: 'strong',
  // Embeddings are not a chat tier. Kept in the map so every purpose resolves,
  // and served from its own configured list.
  embed: 'fast',
})

interface ConfiguredCandidate {
  provider?: unknown
  model?: unknown
  contextWindow?: unknown
  embedding?: unknown
  toolCalling?: unknown
  streaming?: unknown
  structuredOutput?: unknown
  inputPerMillion?: unknown
  outputPerMillion?: unknown
}

/** Tiers a deployment must configure. `embed` is separate from the chat tiers. */
const REQUIRED_KEYS = ['fast', 'balanced', 'strong', 'embed'] as const

function candidateFrom(raw: ConfiguredCandidate, tier: string, index: number): ModelCandidate {
  if (typeof raw.provider !== 'string' || typeof raw.model !== 'string') {
    throw new ConfigurationError(
      `CHORUS_MODEL_TIERS: ${tier}[${index}] needs a provider and a model`,
      { tier },
    )
  }

  const embedding = raw.embedding === true
  return {
    ref: { provider: raw.provider, model: raw.model },
    capabilities: {
      // Defaulted to capable, because the common case is a current model and a
      // deployment that must enumerate every capability will get one wrong.
      // Where it matters — the tier floor below — the value is checked.
      structuredOutput: raw.structuredOutput !== false,
      toolCalling: raw.toolCalling !== false,
      streaming: raw.streaming !== false,
      contextWindow: typeof raw.contextWindow === 'number' ? raw.contextWindow : 0,
      embedding,
    },
    cost: {
      inputPerMillion: typeof raw.inputPerMillion === 'number' ? raw.inputPerMillion : 0,
      outputPerMillion: typeof raw.outputPerMillion === 'number' ? raw.outputPerMillion : 0,
    },
  }
}

/**
 * Builds the router's configuration, or fails at boot.
 *
 * Every failure names the tier. "Which tier is missing" is the whole diagnosis;
 * a generic "invalid configuration" sends an operator to read JSON by eye.
 */
export function routerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RouterConfig & { readonly embed: readonly ModelCandidate[] } {
  const raw = env.CHORUS_MODEL_TIERS
  if (!raw || raw.trim() === '') {
    throw new ConfigurationError(
      'CHORUS_MODEL_TIERS is not set. Every tier must name at least one model; ' +
        'see deploy/model-tiers.example.json.',
    )
  }

  let parsed: Record<string, ConfiguredCandidate[]>
  try {
    parsed = JSON.parse(raw) as Record<string, ConfiguredCandidate[]>
  } catch (error) {
    throw new ConfigurationError('CHORUS_MODEL_TIERS is not valid JSON', {
      reason: error instanceof Error ? error.message : String(error),
    })
  }

  const byTier: Record<string, ModelCandidate[]> = {}

  for (const key of REQUIRED_KEYS) {
    const configured = parsed[key]
    // An empty list is a missing tier, not a configured one. Treating it as
    // configured would let a request resolve to nothing at the moment it runs.
    if (!Array.isArray(configured) || configured.length === 0) {
      throw new ConfigurationError(
        `CHORUS_MODEL_TIERS: tier "${key}" names no model. Every tier must have at least one.`,
        { tier: key },
      )
    }

    byTier[key] = configured.map((candidate, index) => candidateFrom(candidate, key, index))
  }

  // The tier floor, checked at boot. A `strong` model with a 32k window cannot
  // serve what `strong` promises, and finding that out mid-run is a truncated
  // prompt and a wrong answer.
  for (const tier of ['fast', 'balanced', 'strong'] as const) {
    const floor = TIER_REQUIREMENTS[tier].contextWindowTokens ?? 0
    for (const candidate of byTier[tier]!) {
      if (candidate.capabilities.contextWindow < floor) {
        throw new ConfigurationError(
          `CHORUS_MODEL_TIERS: tier "${tier}" requires a context window of at least ${floor}, ` +
            `but "${candidate.ref.model}" declares ${candidate.capabilities.contextWindow}.`,
          { tier, model: candidate.ref.model },
        )
      }
    }
  }

  // Embedding with a chat model produces vectors comparable to nothing, so
  // retrieval degrades to noise rather than failing — which is the worse of the
  // two outcomes and the reason this is checked here.
  for (const candidate of byTier.embed!) {
    if (!candidate.capabilities.embedding) {
      throw new ConfigurationError(
        `CHORUS_MODEL_TIERS: tier "embed" must name embedding models; ` +
          `"${candidate.ref.model}" is not marked as one.`,
        { tier: 'embed', model: candidate.ref.model },
      )
    }
  }

  return {
    purposeToTier: DEFAULT_PURPOSE_TIERS,
    tiers: {
      fast: byTier.fast!,
      balanced: byTier.balanced!,
      strong: byTier.strong!,
    },
    embed: byTier.embed!,
  }
}
