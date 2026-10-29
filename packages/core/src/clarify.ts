import { z } from 'zod'

/**
 * Bounded clarifying questions (CHAT-4, architecture.md §11.3).
 *
 * > An agent that asks nothing produces confident nonsense; an agent that asks
 * > everything is an interrogation and gets abandoned.
 *
 * The bound is the point, and it is enforced here, in code, rather than only in
 * the prompt. A prompt is guidance: a model told "at most three" will sometimes
 * ask four, and the fourth is exactly the one that makes the product feel like
 * an interrogation. So the model proposes, and this disposes — truncating to the
 * budget and dropping anything already settled — which is a guarantee a prompt
 * can never be.
 */

export const DEFAULT_QUESTION_BUDGET = 3

export const ClarificationChoiceSchema = z
  .object({
    /** A stable id, so selecting an option records an answer the next turn can read. */
    id: z.string().min(1),
    label: z.string().min(1),
  })
  .strict()
export type ClarificationChoice = z.infer<typeof ClarificationChoiceSchema>

export const ClarificationQuestionSchema = z
  .object({
    /** Stable within a turn, so an answer can be recorded against the question asked. */
    id: z.string().min(1),
    /**
     * The subject the question resolves — "repository", "target framework".
     *
     * It is what the answer is keyed by, and what makes "never ask what is
     * already known" checkable: a question about a subject already answered, or
     * named as known, is dropped. The model is asked to keep it short and
     * noun-like; this treats it only as a key, never as text shown to anyone.
     */
    about: z.string().min(1),
    question: z.string().min(1),
    /**
     * Selectable options, when the set is knowable (AC2). Always alongside a
     * free-text answer, which needs no declaring: any question may be answered
     * in prose, so the escape is the absence of a constraint rather than an
     * extra option to render.
     */
    choices: z.array(ClarificationChoiceSchema).default([]),
  })
  .strict()
export type ClarificationQuestion = z.infer<typeof ClarificationQuestionSchema>

/**
 * What the model proposes: candidate questions, most important first.
 *
 * A specific request yields an empty list, which is the model saying it has
 * enough to proceed (AC5). The order matters because the budget keeps a prefix.
 */
export const ClarificationSchema = z
  .object({
    questions: z.array(ClarificationQuestionSchema).default([]),
  })
  .strict()
export type Clarification = z.infer<typeof ClarificationSchema>

/**
 * A subject reduced to a comparison key: lower-case, alphanumerics only.
 *
 * So "Target-Framework", "target framework" and "target_framework" are one
 * subject, and a question is not re-asked because the model spelled its own
 * `about` differently from how the answer was stored. Distinct words stay
 * distinct — "repo" is not "repository" — because collapsing those would drop
 * real questions.
 */
export function normaliseSubject(subject: string): string {
  return subject.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export interface BoundClarificationInput {
  readonly proposed: readonly ClarificationQuestion[]
  /** At most this many are asked. Default `DEFAULT_QUESTION_BUDGET`. */
  readonly budget?: number
  /**
   * Subjects already settled: answered earlier in the session, or otherwise
   * known. A proposed question about one of these is dropped (AC3). The
   * "present in the retrieved context" half of AC3 is the prompt's job and is
   * asserted by the golden fixtures; what code guarantees is the budget and
   * that an answered subject is never asked again.
   */
  readonly known: readonly string[]
}

/**
 * The questions actually to ask: known subjects removed, duplicates collapsed,
 * truncated to the budget. Order is preserved, so the budget keeps the most
 * important.
 */
export function boundClarification(input: BoundClarificationInput): readonly ClarificationQuestion[] {
  const budget = Math.max(0, Math.trunc(input.budget ?? DEFAULT_QUESTION_BUDGET))
  const known = new Set(input.known.map(normaliseSubject))
  const seen = new Set<string>()
  const kept: ClarificationQuestion[] = []

  for (const question of input.proposed) {
    if (kept.length >= budget) break
    const subject = normaliseSubject(question.about)
    if (known.has(subject) || seen.has(subject)) continue
    seen.add(subject)
    kept.push(question)
  }

  return kept
}
