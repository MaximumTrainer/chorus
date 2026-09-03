import type { ModelProvider, ModelRef } from '@chorus/llm'
import {
  decideRoute,
  type Candidate,
  type Classification,
  type RoutingDecision,
  type RoutingRule,
  type Trigger,
} from './router.js'

/**
 * The router, wired to a model (AGENT-2).
 *
 * `decideRoute` in `./router.js` is the decision, and it is pure. This is the
 * thin layer that runs a classifier — and only when the pure decision has said
 * one is needed. That ordering is AC1: on a rule match, nothing here reaches
 * the model, which the integration suite asserts by counting the fake
 * provider's requests rather than by reading the code.
 */

export type {
  Trigger,
  TriggerKind,
  RoutingRule,
  RoutingDecision,
  Candidate,
  Classification,
} from './router.js'
export { decideRoute, routingEvent, DEFAULT_CONFIDENCE_THRESHOLD } from './router.js'

export interface RouterOptions {
  readonly rules: readonly RoutingRule[]
  /**
   * The workflows that exist.
   *
   * The classifier is offered these and nothing else: a model asked to choose
   * freely will invent a plausible name, and the run would then fail at load on
   * a workflow nobody wrote. Its answer is filtered against this list too,
   * because a constrained prompt is a request and not a guarantee.
   */
  readonly workflows: readonly string[]
  readonly models: ModelProvider
  readonly modelFor: (tier: string) => ModelRef
  readonly threshold?: number
}

export interface Router {
  route(trigger: Trigger): Promise<RoutingDecision>
}

/**
 * The classifier prompt.
 *
 * Deliberately small and deliberately closed: the list of workflows, the
 * trigger, and a shape to answer in. Classification is the fallback, so it is
 * one question about one trigger — a loop here would multiply the cost of every
 * unmatched turn, which is the thing rules exist to avoid.
 */
function classifierPrompt(trigger: Trigger, workflows: readonly string[]): string {
  return [
    'Choose which workflow should handle this trigger.',
    '',
    'Available workflows (choose only from these):',
    ...workflows.map((workflow) => `- ${workflow}`),
    '',
    'Trigger:',
    JSON.stringify(
      {
        kind: trigger.kind,
        text: trigger.text,
        entryPoint: trigger.entryPoint,
        taskTag: trigger.taskTag,
        integrationKind: trigger.integrationKind,
        captureMode: trigger.captureMode,
      },
      null,
      2,
    ),
    '',
    'Answer with JSON only:',
    '{"candidates":[{"workflow":"<name>","confidence":<0..1>}],"reasoning":"<one sentence>"}',
    '',
    'Include every workflow you seriously considered, with its confidence — not',
    'only the one you chose. If none of them fit, answer with an empty list.',
  ].join('\n')
}

function parseClassification(text: string, workflows: readonly string[]): Classification {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return { candidates: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    // A model that did not answer in the requested shape has not classified
    // anything. Guessing at its intent here would be a second classifier.
    return { candidates: [] }
  }

  const record = parsed as { candidates?: unknown; reasoning?: unknown }
  const known = new Set(workflows)

  const candidates: Candidate[] = Array.isArray(record.candidates)
    ? record.candidates
        .map((entry) => entry as { workflow?: unknown; confidence?: unknown })
        .filter(
          (entry): entry is { workflow: string; confidence: number } =>
            typeof entry.workflow === 'string' &&
            typeof entry.confidence === 'number' &&
            Number.isFinite(entry.confidence) &&
            // Discarded, not repaired. Trusting an invented name would start a
            // run against a definition that does not exist, and fail at the
            // first step rather than here where it is explicable.
            known.has(entry.workflow),
        )
        .map((entry) => ({
          workflow: entry.workflow,
          confidence: Math.min(1, Math.max(0, entry.confidence)),
        }))
    : []

  return {
    candidates,
    ...(typeof record.reasoning === 'string' ? { reasoning: record.reasoning } : {}),
  }
}

export function createRouter(options: RouterOptions): Router {
  return {
    async route(trigger) {
      // First without a classifier. Explicit selection and rules both return
      // here, and neither has cost anything.
      const withoutModel = decideRoute({
        trigger,
        rules: options.rules,
        ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
      })
      if (withoutModel.kind !== 'unroutable') return withoutModel

      let text = ''
      try {
        for await (const event of options.models.stream({
          model: options.modelFor('fast'),
          messages: [{ role: 'user', content: classifierPrompt(trigger, options.workflows) }],
          context: { workspaceId: trigger.workspaceId, teamId: trigger.teamId, purpose: 'classify' },
        })) {
          if (event.type === 'token') text += event.text
          if (event.type === 'error') throw new Error(event.message)
        }
      } catch {
        // A provider outage must not turn every unmatched trigger into a stack
        // trace. "I could not place this" is a usable answer; a 500 is not, and
        // the caller already has to handle unroutable.
        return withoutModel
      }

      return decideRoute({
        trigger,
        rules: options.rules,
        classification: parseClassification(text, options.workflows),
        ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
      })
    },
  }
}
