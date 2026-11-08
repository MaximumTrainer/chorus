import { describe, it, expect } from 'vitest'
import { TransitionError, ValidationError } from '@chorus/core'
import { validateStatusMap, requireMapping, requireTransition, type JiraTransition } from './status-map.js'

/**
 * INT-8 AC5 — the status map is validated and never guessed.
 *
 * Two guarantees, both pure so they can be asserted exactly:
 *  - at save time, a map entry pointing at a Jira status the project does not
 *    have is reported, not silently kept;
 *  - at push time, an unmapped Chorus status is blocked with a message naming
 *    it, and a mapped status Jira cannot currently reach is an illegal
 *    transition — never a guessed "closest" status.
 */

const transitions: JiraTransition[] = [
  { id: '11', name: 'Start', to: { name: 'In Progress' } },
  { id: '31', name: 'Finish', to: { name: 'Done' } },
]

describe('INT-8 status map (AC5)', () => {
  it('INT-8 AC5: validation flags a mapped Jira status the project does not have', () => {
    const problems = validateStatusMap(
      { in_progress: 'In Progress', done: 'Shipped' },
      ['To Do', 'In Progress', 'Done'],
    )
    expect(problems).toEqual([{ chorusStatus: 'done', jiraStatus: 'Shipped' }])
  })

  it('INT-8 AC5: a fully valid map has no problems', () => {
    expect(validateStatusMap({ in_progress: 'In Progress' }, ['In Progress', 'Done'])).toEqual([])
  })

  it('INT-8 AC5: validation is case-insensitive on the Jira status name', () => {
    expect(validateStatusMap({ done: 'done' }, ['Done'])).toEqual([])
  })

  it('INT-8 AC5: an unmapped Chorus status is blocked with a message naming it', () => {
    const raised = (() => {
      try {
        requireMapping('blocked', { done: 'Done' })
      } catch (error) {
        return error
      }
    })()
    expect(raised).toBeInstanceOf(ValidationError)
    expect((raised as ValidationError).message).toMatch(/blocked/)
  })

  it('INT-8 AC5: a mapping returns the Jira status it points at', () => {
    expect(requireMapping('done', { done: 'Done' })).toBe('Done')
  })

  it('INT-8 AC5: a mapped status Jira cannot currently reach is an illegal transition, not a guess', () => {
    const raised = (() => {
      try {
        requireTransition('Done', [{ id: '11', name: 'Start', to: { name: 'In Progress' } }])
      } catch (error) {
        return error
      }
    })()
    expect(raised).toBeInstanceOf(TransitionError)
    expect((raised as TransitionError).message).toMatch(/Done/)
  })

  it('INT-8 AC5: resolves the transition whose target is the mapped status', () => {
    expect(requireTransition('Done', transitions).id).toBe('31')
  })
})
