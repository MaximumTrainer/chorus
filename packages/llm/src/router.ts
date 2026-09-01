import { ConfigurationError } from '@chorus/core'
import type {
  CapabilityRequirements,
  FallbackRecord,
  ModelCandidate,
  Purpose,
  RouterConfig,
  RoutingDecision,
  TokenUsage,
} from './types.js'

/**
 * No model in the resolved tier can meet the request. Thrown before any
 * provider call, so the failure names the missing capability instead of
 * surfacing as a provider-specific error three layers down (NFR-2 AC3).
 */
export class ModelCapabilityError extends ConfigurationError {
  override readonly type = 'model_capability'
  readonly tier: string

  constructor(tier: string, purpose: Purpose, missingByCandidate: readonly FallbackRecord[]) {
    const summary = missingByCandidate
      .map((c) => `${c.ref.provider}/${c.ref.model} lacks ${c.missing.join(', ')}`)
      .join('; ')
    super(
      `No model in tier "${tier}" can serve purpose "${purpose}": ${summary}`,
      { tier, purpose, candidates: missingByCandidate },
    )
    this.tier = tier
  }
}

/** Which requirements a candidate fails. Empty means it can serve the request. */
export function missingCapabilities(
  candidate: ModelCandidate,
  requires: CapabilityRequirements,
): string[] {
  const missing: string[] = []
  const caps = candidate.capabilities

  if (requires.structuredOutput && !caps.structuredOutput) missing.push('structuredOutput')
  if (requires.toolCalling && !caps.toolCalling) missing.push('toolCalling')
  if (requires.streaming && !caps.streaming) missing.push('streaming')
  if (requires.streamingToolDeltas && !caps.streamingToolDeltas) missing.push('streamingToolDeltas')
  if (requires.embedding && !caps.embedding) missing.push('embedding')
  if (
    requires.contextWindowTokens !== undefined &&
    caps.contextWindow < requires.contextWindowTokens
  ) {
    missing.push(`contextWindow (needs ${requires.contextWindowTokens}, has ${caps.contextWindow})`)
  }

  return missing
}

export interface ResolveRequest {
  readonly purpose: Purpose
  readonly requires: CapabilityRequirements
}

export interface ModelRouter {
  resolve(request: ResolveRequest): RoutingDecision
  costCents(candidate: ModelCandidate, usage: TokenUsage): number
}

export function createRouter(config: RouterConfig): ModelRouter {
  return {
    resolve({ purpose, requires }): RoutingDecision {
      const tier = config.purposeToTier[purpose]
      if (!tier) {
        throw new ConfigurationError(`No tier configured for purpose "${purpose}"`, { purpose })
      }

      const candidates = config.tiers[tier]
      if (!candidates || candidates.length === 0) {
        throw new ConfigurationError(`Tier "${tier}" has no models configured`, { tier, purpose })
      }

      const fellBackFrom: FallbackRecord[] = []
      for (const candidate of candidates) {
        const missing = missingCapabilities(candidate, requires)
        if (missing.length === 0) {
          return { chosen: candidate, tier, fellBackFrom }
        }
        fellBackFrom.push({ ref: candidate.ref, missing })
      }

      throw new ModelCapabilityError(tier, purpose, fellBackFrom)
    },

    /**
     * Whole cents. Prices are per million tokens in hundredths of a cent, so
     * this stays integer arithmetic — floating-point money drifts, and the
     * displayed run cost must reconcile exactly with the ledger (NFR-8 AC2).
     */
    costCents(candidate, usage): number {
      const input = usage.inputTokens * candidate.cost.inputPerMillion
      const output = usage.outputTokens * candidate.cost.outputPerMillion
      return Math.round((input + output) / 1_000_000)
    },
  }
}
