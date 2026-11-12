import { describe, it, expect } from 'vitest'
import { entityCitationId, type EntityCitationInput } from './citation-id.js'

/**
 * BRAIN-11 AC5 — citation ids for entities in a bundle.
 *
 * An external-authority entity's id is derived from its `externalUri` plus a
 * provenance hash of the facts its owning source holds, so the id addresses the
 * owning system and a changed fact yields a changed id. A brain-authored
 * entity's id is derived from its own identity and summary.
 */
describe('BRAIN-11 AC5 entity citation ids', () => {
  const external = (over: Partial<EntityCitationInput> = {}): EntityCitationInput => ({
    entityId: 'ent_1',
    kind: 'service',
    name: 'payments',
    authority: 'external',
    externalUri: 'sdlckg://Service/payments',
    attributes: { owner: 'Team Pay', tier: 1 },
    ...over,
  })

  it('BRAIN-11 AC5: an external id is stable while nothing the source owns changes', () => {
    const a = entityCitationId(external(), 'summary text')
    const b = entityCitationId(external(), 'summary text')
    expect(a).toBe(b)
  })

  it('BRAIN-11 AC5: attribute key order does not change the id', () => {
    const a = entityCitationId(external({ attributes: { owner: 'Team Pay', tier: 1 } }), 's')
    const b = entityCitationId(external({ attributes: { tier: 1, owner: 'Team Pay' } }), 's')
    expect(a).toBe(b)
  })

  it('BRAIN-11 AC5: a changed source fact yields a changed id', () => {
    const before = entityCitationId(external({ attributes: { owner: 'Team Pay', tier: 1 } }), 's')
    const after = entityCitationId(external({ attributes: { owner: 'Team Pay', tier: 2 } }), 's')
    expect(after).not.toBe(before)
  })

  it('BRAIN-11 AC5: a different source address yields a different id', () => {
    const a = entityCitationId(external({ externalUri: 'sdlckg://Service/payments' }), 's')
    const b = entityCitationId(external({ externalUri: 'sdlckg://Service/billing' }), 's')
    expect(a).not.toBe(b)
  })

  it('BRAIN-11 AC5: the external id does not depend on the synthesised summary', () => {
    // The summary is derived prose; the id addresses the source, not the
    // sentence Chorus wrote about it, so two renderings cite the same thing.
    const a = entityCitationId(external(), 'payments is a service in this workspace.')
    const b = entityCitationId(external(), 'a completely different sentence')
    expect(a).toBe(b)
  })

  it('BRAIN-11 AC5: a brain entity id is derived from its identity and summary, not an external uri', () => {
    const brain: EntityCitationInput = {
      entityId: 'ent_brain',
      kind: 'feature',
      name: 'checkout',
      authority: 'brain',
      externalUri: null,
      attributes: {},
    }
    const a = entityCitationId(brain, 'checkout is a feature in this workspace.')
    const b = entityCitationId(brain, 'checkout is a feature in this workspace.')
    const c = entityCitationId(brain, 'a changed summary')
    expect(a).toBe(b)
    // A brain entity's page is Chorus's own prose, so a changed summary is a
    // changed citation — the opposite of the external case.
    expect(c).not.toBe(a)
  })
})
