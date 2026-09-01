/**
 * Slugs (WS-3 AC4).
 *
 * A slug is a URL segment and a uniqueness key, so it is bounded, lower-case
 * and ASCII. Collisions resolve to the lowest free numeric suffix rather than
 * to a random one: the same name against the same set of taken slugs must
 * always give the same answer, or a slug becomes something nobody can predict,
 * link to, or write a fixture for.
 */

/** The longest a slug may be, matching the URL segment the UI routes on. */
export const MAX_SLUG_LENGTH = 48

export function slugify(name: string, fallback = 'team'): string {
  const base = name
    .toLowerCase()
    // Decompose accented characters, then drop the combining marks, so "ü"
    // becomes "u" rather than being discarded as a non-ASCII character.
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
  return base || fallback
}

/**
 * The slug for `name` that does not collide with `taken`.
 *
 * Comparison is case-insensitive because the uniqueness index is on
 * `lower(slug)`: a check that respected case would propose a slug the database
 * then rejects.
 */
export function uniqueSlug(name: string, taken: Iterable<string>, fallback = 'team'): string {
  const used = new Set<string>()
  for (const value of taken) used.add(value.toLowerCase())

  const base = slugify(name, fallback)
  if (!used.has(base)) return base

  // Start at 2: the unsuffixed slug is conceptually the first.
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`
    const candidate = `${base.slice(0, MAX_SLUG_LENGTH - tail.length).replace(/-+$/, '')}${tail}`
    if (!used.has(candidate)) return candidate
  }
}
