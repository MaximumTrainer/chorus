import { describe, it, expect } from 'vitest'
import {
  EntityCandidateSchema,
  ENTITY_KINDS,
  EXTERNAL_AUTHORITY_KINDS,
  isExternalAuthorityKind,
  parseExternalUri,
} from './entities.js'

/**
 * BRAIN-11 AC1 — operational kinds exist and carry external authority.
 *
 * `service`, `environment`, `deployment` and `resource` are references to facts
 * an external graph owns, so they must declare `authority: 'external'` with a
 * parseable `externalUri`; a brain-authored one is a contradiction in terms.
 * Every other kind defaults to `authority: 'brain'`.
 */

const evidence = { signalExternalId: 's:1', source: 'sdlc_graph' }

describe('BRAIN-11 entity authority (AC1)', () => {
  it('BRAIN-11 AC1: the operational kinds are part of the schema', () => {
    for (const kind of ['service', 'environment', 'deployment', 'resource']) {
      expect(ENTITY_KINDS).toContain(kind)
      expect(EXTERNAL_AUTHORITY_KINDS).toContain(kind)
      expect(isExternalAuthorityKind(kind)).toBe(true)
    }
    expect(isExternalAuthorityKind('ticket')).toBe(false)
  })

  it('BRAIN-11 AC1: an existing kind needs no authority and parses (the store defaults it to brain)', () => {
    const parsed = EntityCandidateSchema.parse({ kind: 'ticket', externalId: 'jira:issue:X', name: 'X', evidence })
    expect(parsed.authority).toBeUndefined()
  })

  it('BRAIN-11 AC1: an operational kind with external authority and a parseable uri is accepted', () => {
    const parsed = EntityCandidateSchema.parse({
      kind: 'service',
      externalId: 'sdlckg:Service:checkout',
      name: 'checkout',
      authority: 'external',
      externalUri: 'sdlckg://Service/checkout',
      evidence,
    })
    expect(parsed.authority).toBe('external')
    expect(parsed.externalUri).toBe('sdlckg://Service/checkout')
  })

  it('BRAIN-11 AC1: an operational kind with brain authority is refused', () => {
    const result = EntityCandidateSchema.safeParse({
      kind: 'service',
      externalId: 'sdlckg:Service:checkout',
      name: 'checkout',
      authority: 'brain',
      evidence,
    })
    expect(result.success).toBe(false)
  })

  it('BRAIN-11 AC1: external authority without a parseable uri is refused', () => {
    expect(
      EntityCandidateSchema.safeParse({
        kind: 'service',
        externalId: 'x',
        name: 'checkout',
        authority: 'external',
        externalUri: 'not a uri',
        evidence,
      }).success,
    ).toBe(false)
    expect(
      EntityCandidateSchema.safeParse({
        kind: 'deployment',
        externalId: 'x',
        name: 'd',
        authority: 'external',
        evidence,
      }).success,
    ).toBe(false)
  })

  it('BRAIN-11 AC1: parseExternalUri splits a uri into scheme, type and id', () => {
    expect(parseExternalUri('sdlckg://Environment/prod-eu')).toEqual({
      scheme: 'sdlckg',
      type: 'Environment',
      id: 'prod-eu',
    })
    expect(parseExternalUri('not a uri')).toBeNull()
  })
})
