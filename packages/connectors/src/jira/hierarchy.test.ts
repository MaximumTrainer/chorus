import { describe, it, expect } from 'vitest'
import { ValidationError } from '@chorus/core'
import { detectHierarchyScheme, hierarchyFields } from './hierarchy.js'

/**
 * INT-8 AC4 — the hierarchy scheme is detected, not assumed.
 *
 * A company-managed ("classic") project links a story to its epic through the
 * Epic Link custom field; a team-managed ("next-gen") project links every level
 * through `parent`. Pushing with the wrong one silently fails to build the tree,
 * so the scheme is read from the project at connect time and the push obeys it.
 */
describe('INT-8 hierarchy detection (AC4)', () => {
  const fields = [
    { id: 'summary', name: 'Summary' },
    { id: 'customfield_10014', name: 'Epic Link' },
    { id: 'parent', name: 'Parent' },
  ]

  it('INT-8 AC4: a team-managed project links through parent', () => {
    expect(detectHierarchyScheme('next-gen', fields)).toEqual({ scheme: 'parent' })
  })

  it('INT-8 AC4: a company-managed project links through the Epic Link field', () => {
    expect(detectHierarchyScheme('classic', fields)).toEqual({
      scheme: 'epic_link',
      epicLinkFieldId: 'customfield_10014',
    })
  })

  it('INT-8 AC4: on a company-managed project a story is linked to its epic through the Epic Link field', () => {
    expect(
      hierarchyFields({ scheme: 'epic_link', epicLinkFieldId: 'customfield_10014' }, 'ACME-1', true),
    ).toEqual({ customfield_10014: 'ACME-1' })
  })

  it('INT-8 AC4: a subtask uses parent even on a company-managed project', () => {
    expect(
      hierarchyFields({ scheme: 'epic_link', epicLinkFieldId: 'customfield_10014' }, 'ACME-2', false),
    ).toEqual({ parent: { key: 'ACME-2' } })
  })

  it('INT-8 AC4: a team-managed project links every level through parent', () => {
    expect(hierarchyFields({ scheme: 'parent' }, 'ACME-1', true)).toEqual({ parent: { key: 'ACME-1' } })
  })

  it('INT-8 AC4: an epic link with no Epic Link field is blocked, not guessed', () => {
    expect(() => hierarchyFields({ scheme: 'epic_link' }, 'ACME-1', true)).toThrow(ValidationError)
  })
})
