import { describe, it, expect } from 'vitest'
import { slugify, uniqueSlug } from './slugs.js'

/**
 * WS-3 AC4 — slugs are unique per workspace, and collisions resolve
 * deterministically.
 *
 * "Deterministically" is the whole point: the same name against the same set of
 * taken slugs must always produce the same answer, or a slug becomes something
 * nobody can predict, link to, or write a fixture for.
 */
describe('WS-3 slugs', () => {
  it('WS-3 AC4: a name becomes a lower-case, URL-safe slug', () => {
    expect(slugify('Payments')).toBe('payments')
    expect(slugify('Growth & Retention')).toBe('growth-retention')
    expect(slugify('  Trailing and leading  ')).toBe('trailing-and-leading')
    expect(slugify('Ünïcödé Naming')).toBe('unicode-naming')
  })

  it('WS-3 AC4: a name with no slug-able characters still yields a usable slug', () => {
    // An empty slug would collide with every other empty slug and produce a
    // URL of `/teams/`, so there is a floor rather than an empty string.
    expect(slugify('!!!')).toBe('team')
    expect(slugify('')).toBe('team')
  })

  it('WS-3 AC4: a slug is bounded, because it is a URL segment and an index key', () => {
    expect(slugify('a'.repeat(200))).toHaveLength(48)
  })

  it('WS-3 AC4: an uncontested name keeps its natural slug', () => {
    expect(uniqueSlug('Payments', [])).toBe('payments')
    expect(uniqueSlug('Payments', ['growth', 'platform'])).toBe('payments')
  })

  it('WS-3 AC4: a collision is resolved by the lowest free suffix, never by chance', () => {
    expect(uniqueSlug('Growth', ['growth'])).toBe('growth-2')
    expect(uniqueSlug('Growth', ['growth', 'growth-2'])).toBe('growth-3')
    // A gap is filled rather than skipped: deleting `growth-2` and re-creating
    // it must give back the same slug, not drift upwards forever.
    expect(uniqueSlug('Growth', ['growth', 'growth-3'])).toBe('growth-2')
  })

  it('WS-3 AC4: resolution is deterministic — the same inputs always give the same slug', () => {
    const taken = ['growth', 'growth-2', 'growth-4']
    expect(uniqueSlug('Growth', taken)).toBe(uniqueSlug('Growth', taken))
    expect(uniqueSlug('Growth', taken)).toBe('growth-3')
  })

  it('WS-3 AC4: comparison against taken slugs is case-insensitive', () => {
    // The uniqueness index is on `lower(slug)`, so a check that respected case
    // would propose a slug the database then rejects.
    expect(uniqueSlug('Growth', ['GROWTH'])).toBe('growth-2')
  })

  it('WS-3 AC4: a suffixed slug stays within the length bound', () => {
    const long = 'a'.repeat(60)
    expect(uniqueSlug(long, ['a'.repeat(48)]).length).toBeLessThanOrEqual(48)
  })
})
