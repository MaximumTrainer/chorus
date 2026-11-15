import { describe, it, expect } from 'vitest'
import { isVisibleTo, type SignalPermissions } from '@chorus/core'

/**
 * NFR-4 / INT-9 AC4 — page restrictions govern who can retrieve ingested content.
 *
 * This proves the enforcement *decision*: content a connector captured as
 * restricted to a group is shown only to a viewer in that group, and never to
 * one outside it, fail-closed. These are exactly the scope ids the Confluence
 * connector puts on a restricted page (`confluence:group:<name>`,
 * `confluence:user:<id>`).
 *
 * The wiring that calls this at a real retrieval path, and the mapping that
 * populates a viewer's external-group memberships, are the two downstream pieces
 * tracked on issue #242; this is the primitive they both build on.
 */
describe('NFR-4 ingested-content visibility (INT-9 AC4)', () => {
  const restrictedToGroup: Pick<SignalPermissions, 'visibility' | 'scopeIds'> = {
    visibility: 'restricted',
    scopeIds: ['confluence:group:eng-admins'],
  }

  it('NFR-4: a page restricted to a group is visible to a member of that group', () => {
    const viewer = new Set(['confluence:group:eng-admins', 'confluence:user:u-1'])
    expect(isVisibleTo(restrictedToGroup, viewer)).toBe(true)
  })

  it('NFR-4: the same page is invisible to a user outside the group', () => {
    const outsider = new Set(['confluence:group:sales', 'confluence:user:u-2'])
    expect(isVisibleTo(restrictedToGroup, outsider)).toBe(false)
  })

  it('NFR-4: a viewer with no memberships at all sees no restricted content (fail-closed)', () => {
    expect(isVisibleTo(restrictedToGroup, new Set())).toBe(false)
  })

  it('NFR-4: public ingested content is visible to everyone', () => {
    expect(isVisibleTo({ visibility: 'public', scopeIds: [] }, new Set())).toBe(true)
  })
})
