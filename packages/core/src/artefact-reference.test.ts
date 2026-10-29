import { describe, it, expect } from 'vitest'
import { resolveArtefactReference, type ArtefactCandidate } from './artefact-reference.js'

const task = (key: string, title: string): ArtefactCandidate => ({ kind: 'task', id: key.toLowerCase(), key, title })
const doc = (id: string, title: string): ArtefactCandidate => ({ kind: 'document', id, key: null, title })

describe('CHAT-6 artefact reference resolution', () => {
  const candidates: ArtefactCandidate[] = [
    task('CH-12', 'Split the invoice parser'),
    task('CH-3', 'Rate limit the API'),
    doc('d1', 'Billing PRD'),
    doc('d2', 'Billing spec'),
    doc('d3', 'Onboarding spec'),
  ]

  it('CHAT-6: reference resolution ranks candidates and reports ambiguity', () => {
    // An exact key is unambiguous, whatever else is around.
    expect(resolveArtefactReference('add criteria to CH-12', candidates)).toEqual({
      status: 'resolved',
      match: expect.objectContaining({ key: 'CH-12' }),
    })

    // A key is matched case- and format-insensitively.
    expect(resolveArtefactReference('ch12', candidates)).toMatchObject({
      status: 'resolved',
      match: { key: 'CH-12' },
    })

    // A distinctive title phrase resolves to the one it names.
    expect(resolveArtefactReference('condense the Onboarding spec', candidates)).toMatchObject({
      status: 'resolved',
      match: { id: 'd3' },
    })

    // "the spec" matches two documents: ambiguous, and it says which.
    const ambiguous = resolveArtefactReference('tidy up the spec', candidates)
    expect(ambiguous.status).toBe('ambiguous')
    if (ambiguous.status === 'ambiguous') {
      expect(ambiguous.candidates.map((c) => c.id).sort()).toEqual(['d2', 'd3'])
    }

    // Nothing plausible matches: resolved to none, not to a wrong guess.
    expect(resolveArtefactReference('write something about payroll', candidates)).toEqual({
      status: 'none',
    })
  })

  it('CHAT-6: a key that matches nothing is not forced onto a title', () => {
    expect(resolveArtefactReference('update CH-99', candidates)).toEqual({ status: 'none' })
  })

  it('CHAT-6: an exact title wins over a partial one', () => {
    const withOverlap: ArtefactCandidate[] = [doc('a', 'Billing'), doc('b', 'Billing spec')]
    expect(resolveArtefactReference('open Billing', withOverlap)).toMatchObject({
      status: 'resolved',
      match: { id: 'a' },
    })
  })
})
