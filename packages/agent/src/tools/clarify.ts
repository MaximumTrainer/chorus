import { z } from 'zod'
import {
  ClarificationQuestionSchema,
  ClarificationSchema,
  DEFAULT_QUESTION_BUDGET,
  boundClarification,
  type Tool,
} from '@chorus/core'

/**
 * `clarify` (CHAT-4, architecture.md §11.3).
 *
 * The model proposes clarifying questions; this disposes of them. It is the
 * code half of the guarantee: the budget and the "never re-ask what is already
 * settled" rule are enforced here, after the model has returned, so a model
 * that ignores its instructions is still held to them (CHAT-4 implementation
 * note). It is pure — the bounding lives in `@chorus/core` and is unit-tested
 * there — so a workflow can call it the same way it calls any other tool and
 * the result is traced like any other step.
 *
 * `known` is the subjects already answered in the session, passed in by the
 * turn from `session_answers`. A tool cannot read the database, which is the
 * point: the suppression input is explicit and visible in the trace rather than
 * a hidden lookup.
 */

const Input = z.object({
  /** The model's proposed questions, taken whole from the clarify model step. */
  clarification: ClarificationSchema,
  /** Subjects already answered or otherwise known; a question about one is dropped. */
  known: z.array(z.string()).default([]),
  budget: z.number().int().min(0).max(10).default(DEFAULT_QUESTION_BUDGET),
})

const Output = z.object({
  /**
   * Whether to proceed to answering without asking. Named `ok` so a `branch`
   * step reading `{{step.output}}` takes its `then` arm when there is nothing
   * to ask, which is the convention the executor's `isSatisfied` honours.
   */
  ok: z.boolean(),
  /** True when questions remain to ask, so the turn stops and asks them. */
  asked: z.boolean(),
  questions: z.array(ClarificationQuestionSchema),
})

export function createClarifyTool(): Tool<z.infer<typeof Input>, z.infer<typeof Output>> {
  return {
    name: 'clarify',
    description:
      'Decides which clarifying questions to actually ask, from the ones proposed: at most the ' +
      'budget, never one about a subject already answered. Returns the questions to ask, and ' +
      'whether to proceed without asking.',
    input: Input,
    output: Output,
    // It reads nothing and writes nothing: it is a decision over its inputs.
    sideEffect: 'none',
    requiredRole: 'member',
    requiredScopes: [],
    async execute(input) {
      const questions = boundClarification({
        proposed: input.clarification.questions,
        known: input.known,
        budget: input.budget,
      })
      return { ok: questions.length === 0, asked: questions.length > 0, questions: [...questions] }
    },
  }
}
