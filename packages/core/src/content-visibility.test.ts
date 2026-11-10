import { describe, it, expect } from 'vitest'
import { isVisibleTo } from './content-visibility.js'

const viewer = (ids: string[]): ReadonlySet<string> => new Set(ids)

describe('content visibility (NFR-4, INT-9 AC4)', () => {
  it('public content is visible to everyone, even a viewer in no scope', () => {
    expect(isVisibleTo({ visibility: 'public', scopeIds: [] }, viewer([]))).toBe(true)
  })

  it('restricted content is visible to a viewer who shares a scope', () => {
    expect(
      isVisibleTo({ visibility: 'restricted', scopeIds: ['confluence:group:eng'] }, viewer(['confluence:group:eng'])),
    ).toBe(true)
  })

  it('restricted content is invisible to a viewer outside every scope (fail-closed)', () => {
    expect(
      isVisibleTo({ visibility: 'restricted', scopeIds: ['confluence:group:eng'] }, viewer(['confluence:group:sales'])),
    ).toBe(false)
  })

  it('a viewer in no scope at all sees no restricted content', () => {
    expect(isVisibleTo({ visibility: 'restricted', scopeIds: ['confluence:group:eng'] }, viewer([]))).toBe(false)
  })

  it('a user scope grants visibility just as a group scope does', () => {
    expect(
      isVisibleTo({ visibility: 'restricted', scopeIds: ['confluence:user:u-7'] }, viewer(['confluence:user:u-7'])),
    ).toBe(true)
  })

  it('any one overlapping scope is enough', () => {
    expect(isVisibleTo({ visibility: 'restricted', scopeIds: ['a', 'b', 'c'] }, viewer(['x', 'b']))).toBe(true)
  })
})
