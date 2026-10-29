import { describe, it, expect } from 'vitest'
import {
  DEFAULT_QUESTION_BUDGET,
  boundClarification,
  normaliseSubject,
  type ClarificationQuestion,
} from './clarify.js'

const question = (about: string, extra: Partial<ClarificationQuestion> = {}): ClarificationQuestion => ({
  id: extra.id ?? about,
  about,
  question: extra.question ?? `What about ${about}?`,
  choices: extra.choices ?? [],
})

describe('CHAT-4 bounding clarifying questions', () => {
  it('CHAT-4: the question budget is enforced independently of model output', () => {
    // A model that ignores the instruction and proposes five is still held to N.
    const proposed = ['a', 'b', 'c', 'd', 'e'].map((s) => question(s))

    expect(boundClarification({ proposed, known: [] })).toHaveLength(DEFAULT_QUESTION_BUDGET)
    expect(boundClarification({ proposed, budget: 2, known: [] }).map((q) => q.about)).toEqual(['a', 'b'])
  })

  it('CHAT-4: a question whose subject is already answered is dropped (never ask what is known)', () => {
    const proposed = [question('repository'), question('target framework'), question('deadline')]

    // "target_framework" was answered earlier; the subject matches regardless of spacing or case.
    const kept = boundClarification({ proposed, known: ['Target_Framework'], budget: 3 })

    expect(kept.map((q) => q.about)).toEqual(['repository', 'deadline'])
  })

  it('CHAT-4: two questions about the same subject collapse to one', () => {
    const proposed = [question('repository', { id: 'q1' }), question('repository', { id: 'q2' })]

    expect(boundClarification({ proposed, known: [] })).toHaveLength(1)
  })

  it('CHAT-4: a specific request, with nothing proposed, asks nothing', () => {
    expect(boundClarification({ proposed: [], known: [] })).toEqual([])
  })

  it('CHAT-4: dropping known subjects still fills the budget from what remains', () => {
    const proposed = ['a', 'b', 'c', 'd'].map((s) => question(s))

    // 'a' is known, so the kept three are the next three, not two.
    expect(boundClarification({ proposed, known: ['a'], budget: 3 }).map((q) => q.about)).toEqual([
      'b',
      'c',
      'd',
    ])
  })

  it('CHAT-4: a question keeps its selectable choices, which are the multiple-choice options', () => {
    const proposed = [
      question('repository', {
        choices: [
          { id: 'web', label: 'acme/web' },
          { id: 'api', label: 'acme/api' },
        ],
      }),
    ]

    expect(boundClarification({ proposed, known: [] })[0]!.choices).toHaveLength(2)
  })

  it('CHAT-4: normaliseSubject is stable across case, spacing and punctuation', () => {
    expect(normaliseSubject(' Target-Framework ')).toBe(normaliseSubject('target framework'))
    expect(normaliseSubject('repo')).not.toBe(normaliseSubject('repository'))
  })
})
