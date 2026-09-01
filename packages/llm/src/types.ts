/**
 * The provider-agnostic vocabulary of architecture.md §9.
 *
 * Nothing outside this package may name a provider or a model. Callers name a
 * *purpose*; configuration decides the rest (ADR-0005). The dependency-boundary
 * suite enforces that mechanically.
 */

/** What the call is for. Routing is configured per purpose, not per call site. */
export type Purpose =
  | 'chat'
  | 'classify'
  | 'extract'
  | 'draft'
  | 'decompose'
  | 'code'
  | 'summarise'
  | 'embed'

/** Capability and cost bands. Workspaces map purposes onto these. */
export type Tier = 'fast' | 'balanced' | 'strong'

export interface ModelRef {
  readonly provider: string
  readonly model: string
}

/**
 * What a model can actually do. Providers differ enough that a request must be
 * matched against this before it is sent, rather than discovering the gap in a
 * provider error (NFR-2 AC3).
 */
export interface ModelCapabilities {
  readonly structuredOutput: boolean
  readonly toolCalling: boolean
  readonly streaming: boolean
  /** Some providers stream text but not tool-call deltas. */
  readonly streamingToolDeltas?: boolean
  readonly contextWindow: number
  readonly embedding: boolean
}

/** Price in hundredths of a cent per million tokens, so integer arithmetic stays exact. */
export interface ModelCost {
  readonly inputPerMillion: number
  readonly outputPerMillion: number
}

export interface ModelCandidate {
  readonly ref: ModelRef
  readonly capabilities: ModelCapabilities
  readonly cost: ModelCost
}

/** What a particular request needs. Absent fields mean "don't care". */
export interface CapabilityRequirements {
  readonly structuredOutput?: boolean
  readonly toolCalling?: boolean
  readonly streaming?: boolean
  readonly streamingToolDeltas?: boolean
  readonly embedding?: boolean
  readonly contextWindowTokens?: number
}

export interface RouterConfig {
  readonly purposeToTier: Readonly<Record<Purpose, Tier>>
  /** Ordered per tier: index 0 is preferred, later entries are fallbacks. */
  readonly tiers: Readonly<Record<Tier, readonly ModelCandidate[]>>
}

export interface FallbackRecord {
  readonly ref: ModelRef
  /** Which requirements this candidate failed to meet. */
  readonly missing: readonly string[]
}

export interface RoutingDecision {
  readonly chosen: ModelCandidate
  readonly tier: Tier
  /**
   * Candidates skipped, and why. Written to the run trace so a silent downgrade
   * is impossible to miss (NFR-2 AC3, AGENT-4).
   */
  readonly fellBackFrom: readonly FallbackRecord[]
}

export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

/** Provenance stamped on every call, so spend and traces attribute correctly. */
export interface CallContext {
  readonly workspaceId: string
  readonly teamId: string
  readonly runId?: string
  readonly purpose: Purpose
}
