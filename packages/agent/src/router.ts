/**
 * The workflow router (AGENT-2, architecture.md §11.2).
 *
 * > explicit rules first … and an **LLM classifier only as fallback**. Below a
 * > confidence threshold the agent asks rather than guesses.
 *
 * The requirement is an ordering, and each step down it is slower, costlier and
 * less explicable than the one above:
 *
 *   1. the caller named a workflow          — nothing to decide
 *   2. a rule matches                       — deterministic, no model call
 *   3. a classifier is confident            — one model call, recorded
 *   4. a classifier is not confident        — ask the person
 *   5. nothing places it                    — say so
 *
 * `decideRoute` is **pure**, and takes the classifier's answer as an argument
 * rather than calling one. That is what makes AC1 — "no model call is made" on
 * a rule match — a property of the code's shape rather than something to
 * remember: a rule match returns before anything could have asked. The caller
 * classifies only when this function has told it that classification is needed.
 */

export type TriggerKind = 'chat' | 'signal' | 'schedule' | 'api' | 'mcp' | 'extension'

/** What arrived. Every field a rule may read lives here, and nowhere else. */
export interface Trigger {
  readonly kind: TriggerKind
  /**
   * Where it arrived. Required, because classification is a model call and a
   * model call that cannot be attributed to a workspace cannot be billed,
   * budgeted or capped (NFR-2).
   */
  readonly workspaceId: string
  /** The team it acts for, which is what its charter and policies hang off. */
  readonly teamId: string
  readonly text?: string
  /** The surface it came from — a chat channel, an extension panel, a route. */
  readonly entryPoint?: string
  readonly taskTag?: string
  readonly integrationKind?: string
  readonly slashCommand?: string
  readonly captureMode?: string
  /**
   * A workflow the caller named outright (AC5). Bypasses everything: running a
   * rule over it would let the table quietly override what was asked for.
   */
  readonly explicitWorkflow?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/**
 * One routing rule.
 *
 * Data, ordered, first-match. "Scattered routing conditions are how this
 * becomes unexplainable" — so the table is the only place a rule may live, and
 * precedence is the written order rather than anything derived. A table whose
 * precedence depends on specificity scoring is one nobody can predict.
 */
export interface RoutingRule {
  readonly id: string
  readonly workflow: string
  readonly when: (trigger: Trigger) => boolean
  /** Why this rule exists, surfaced in the trace when it fires. */
  readonly because?: string
}

export interface Candidate {
  readonly workflow: string
  readonly confidence: number
}

export interface Classification {
  /** Every candidate considered, not only the winner. */
  readonly candidates: readonly Candidate[]
  readonly reasoning?: string
}

export type RoutingDecision =
  | { readonly kind: 'explicit'; readonly workflow: string; readonly trigger: Trigger }
  | {
      readonly kind: 'rule'
      readonly workflow: string
      readonly rule: string
      readonly because?: string
      readonly trigger: Trigger
    }
  | {
      readonly kind: 'classified'
      readonly workflow: string
      readonly confidence: number
      readonly candidates: readonly Candidate[]
      readonly reasoning?: string
      readonly trigger: Trigger
    }
  | {
      readonly kind: 'ask'
      readonly candidates: readonly Candidate[]
      readonly reasoning?: string
      readonly trigger: Trigger
    }
  | { readonly kind: 'unroutable'; readonly reason: string; readonly trigger: Trigger }

/**
 * The confidence a classifier must reach to be acted on.
 *
 * 0.7 rather than a bare majority: the cost of routing wrongly is a run that
 * does the wrong work and has to be explained, while the cost of asking is one
 * question. Those are not symmetric, and the threshold should not pretend they
 * are.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7

/**
 * How close two candidates may be before a win stops counting as one.
 *
 * 0.72 against 0.71 is not confidence; it is a coin toss that happens to land
 * above a line. Guessing there is how a person learns not to trust the agent
 * with anything ambiguous.
 */
const DECISIVE_MARGIN = 0.1

export interface RouteInput {
  readonly trigger: Trigger
  readonly rules: readonly RoutingRule[]
  /** Supplied only when the caller has already been told classification is needed. */
  readonly classification?: Classification
  readonly threshold?: number
}

export function decideRoute(input: RouteInput): RoutingDecision {
  const { trigger, rules, classification } = input
  const threshold = input.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD

  if (trigger.explicitWorkflow) {
    return { kind: 'explicit', workflow: trigger.explicitWorkflow, trigger }
  }

  for (const rule of rules) {
    let matched = false
    try {
      matched = rule.when(trigger)
    } catch {
      // Rules are data, written by whoever adds an integration, and one will
      // eventually read a field that is not there. Falling through is a worse
      // answer than the rule would have given and a far better one than every
      // trigger failing — and the rule below may still place it correctly.
      continue
    }
    if (matched) {
      return {
        kind: 'rule',
        workflow: rule.workflow,
        rule: rule.id,
        ...(rule.because ? { because: rule.because } : {}),
        trigger,
      }
    }
  }

  if (!classification || classification.candidates.length === 0) {
    return {
      kind: 'unroutable',
      reason:
        'No rule matched this trigger and no workflow could be identified for it. ' +
        'Naming a workflow explicitly, or adding a routing rule, will place it.',
      trigger,
    }
  }

  const ranked = [...classification.candidates].sort((a, b) => b.confidence - a.confidence)
  const best = ranked[0]!
  const runnerUp = ranked[1]

  const decisive =
    best.confidence >= threshold &&
    (runnerUp === undefined || best.confidence - runnerUp.confidence >= DECISIVE_MARGIN)

  if (decisive) {
    return {
      kind: 'classified',
      workflow: best.workflow,
      confidence: best.confidence,
      candidates: ranked,
      ...(classification.reasoning ? { reasoning: classification.reasoning } : {}),
      trigger,
    }
  }

  // The ones it was actually torn between. Offering everything, including a
  // candidate scored 0.05, would make the question harder to answer than the
  // original request was to make.
  const plausible = ranked.filter((candidate) => candidate.confidence >= best.confidence / 2)

  return {
    kind: 'ask',
    candidates: plausible.length > 1 ? plausible : ranked.slice(0, 2),
    ...(classification.reasoning ? { reasoning: classification.reasoning } : {}),
    trigger,
  }
}

/** Whether the caller needs to run a classifier at all. */
export function needsClassification(trigger: Trigger, rules: readonly RoutingRule[]): boolean {
  return decideRoute({ trigger, rules }).kind === 'unroutable'
}

/**
 * The decision, shaped for `run_events` (AC4).
 *
 * One function so every surface logs the same fields. The trace has to answer
 * "why did it do that", and it can only do so if the record names the workflow,
 * the deciding rule *or* the full classifier output, and the trigger — which is
 * why the trigger is carried on the decision rather than passed separately.
 */
export function routingEvent(decision: RoutingDecision): Record<string, unknown> {
  const base = {
    decision: decision.kind,
    trigger: {
      kind: decision.trigger.kind,
      ...(decision.trigger.entryPoint ? { entryPoint: decision.trigger.entryPoint } : {}),
      ...(decision.trigger.taskTag ? { taskTag: decision.trigger.taskTag } : {}),
      ...(decision.trigger.slashCommand ? { slashCommand: decision.trigger.slashCommand } : {}),
      ...(decision.trigger.captureMode ? { captureMode: decision.trigger.captureMode } : {}),
      ...(decision.trigger.integrationKind
        ? { integrationKind: decision.trigger.integrationKind }
        : {}),
    },
  }

  switch (decision.kind) {
    case 'explicit':
      return { ...base, workflow: decision.workflow }
    case 'rule':
      return {
        ...base,
        workflow: decision.workflow,
        rule: decision.rule,
        ...(decision.because ? { because: decision.because } : {}),
      }
    case 'classified':
      return {
        ...base,
        workflow: decision.workflow,
        confidence: decision.confidence,
        candidates: decision.candidates,
        ...(decision.reasoning ? { reasoning: decision.reasoning } : {}),
      }
    case 'ask':
      return {
        ...base,
        candidates: decision.candidates,
        ...(decision.reasoning ? { reasoning: decision.reasoning } : {}),
      }
    case 'unroutable':
      return { ...base, reason: decision.reason }
  }
}
