/**
 * Checkpoint policies (WS-3 AC5, architecture.md §11.5).
 *
 * A checkpoint is where an autonomous step stops and asks a human. Its policy
 * decides whether it stops at all, so this function is the difference between
 * an agent that proposes and one that acts unattended. It is pure, it lives
 * here once, and both the API and the agent runtime consume it — two
 * implementations would eventually disagree, and a disagreement here is a gate
 * that silently stopped gating.
 *
 * Resolution order, most specific first:
 *
 *   1. team + workflow + kind
 *   2. team + kind
 *   3. workflow + kind        — the workflow default, applying to every team
 *   4. platform default       — `ask`, and deliberately not stored anywhere
 *
 * There is no "everything, everywhere" tier. A single row that opened every
 * gate in a workspace is exactly the thing that should not be settable in
 * passing; workspace-wide settings arrive deliberately with WS-7.
 */

export const CHECKPOINT_KINDS = [
  'before_create_artefacts',
  'before_external_write',
  'before_coding_job',
  'before_spend_over',
] as const
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number]

export const CHECKPOINT_MODES = ['auto', 'ask', 'never'] as const
export type CheckpointMode = (typeof CHECKPOINT_MODES)[number]

/**
 * The platform default is `ask`, and it fails *closed*: a missing policy means
 * "stop and ask", never "go ahead". An unconfigured workspace must not be
 * autonomous by omission.
 */
export const PLATFORM_DEFAULT_MODE: CheckpointMode = 'ask'

export interface PolicyRule {
  /** Absent means the rule is not team-scoped. */
  readonly teamId?: string | undefined
  /** Absent means the rule is not workflow-scoped. */
  readonly workflowName?: string | undefined
  readonly checkpointKind: CheckpointKind
  readonly mode: CheckpointMode
  /** Only meaningful for `before_spend_over`. */
  readonly spendThresholdCents?: number | undefined
}

export interface PolicyQuery {
  readonly teamId: string
  /** Absent for an ad-hoc agent turn, which belongs to no named workflow. */
  readonly workflowName?: string | undefined
  readonly checkpointKind: CheckpointKind
}

/** Which tier decided, so a surprising decision is diagnosable rather than a shrug. */
export type PolicySource = 'team+workflow' | 'team' | 'workflow' | 'platform'

export interface ResolvedPolicy {
  readonly mode: CheckpointMode
  readonly source: PolicySource
  readonly spendThresholdCents?: number
}

export function resolveCheckpointPolicy(
  rules: readonly PolicyRule[],
  query: PolicyQuery,
): ResolvedPolicy {
  const forKind = rules.filter((rule) => rule.checkpointKind === query.checkpointKind)

  // Ordered most specific first. A tier keyed by workflow can only match when
  // the query names one, so an ad-hoc turn never inherits a workflow's policy.
  const tiers: ReadonlyArray<{ source: PolicySource; match: (rule: PolicyRule) => boolean }> = [
    {
      source: 'team+workflow',
      match: (rule) =>
        query.workflowName !== undefined &&
        rule.teamId === query.teamId &&
        rule.workflowName === query.workflowName,
    },
    {
      source: 'team',
      match: (rule) => rule.teamId === query.teamId && rule.workflowName === undefined,
    },
    {
      source: 'workflow',
      match: (rule) =>
        query.workflowName !== undefined &&
        rule.teamId === undefined &&
        rule.workflowName === query.workflowName,
    },
  ]

  for (const tier of tiers) {
    const hit = forKind.find(tier.match)
    if (hit) {
      return {
        mode: hit.mode,
        source: tier.source,
        ...(hit.spendThresholdCents === undefined
          ? {}
          : { spendThresholdCents: hit.spendThresholdCents }),
      }
    }
  }

  return { mode: PLATFORM_DEFAULT_MODE, source: 'platform' }
}

export function isCheckpointKind(value: unknown): value is CheckpointKind {
  return typeof value === 'string' && (CHECKPOINT_KINDS as readonly string[]).includes(value)
}

export function isCheckpointMode(value: unknown): value is CheckpointMode {
  return typeof value === 'string' && (CHECKPOINT_MODES as readonly string[]).includes(value)
}
