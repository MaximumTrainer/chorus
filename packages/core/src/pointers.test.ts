import { describe, it, expect } from 'vitest'
import { MIN_POINTER_CONFIDENCE, deepLink, isPointerSource } from './pointers.js'

/**
 * TASK-3 — deep-link construction per provider.
 *
 * > A pointer that does not resolve is worse than none: it teaches everyone,
 * > human and machine, to distrust all of them.
 *
 * A link that opens the wrong file resolves in the sense that the browser
 * shows something, which is the worse kind of not resolving. So these tests
 * are mostly about the details that quietly break a URL: path characters that
 * need encoding, providers whose route shape differs, and the difference
 * between pinning a commit and following a branch.
 */
describe('TASK-3 pointer deep links', () => {
  const base = { fullName: 'acme/billing', path: 'src/invoice.ts', commitSha: 'abc123' }

  it('TASK-3 AC3: a GitHub link pins the commit, the file and the lines', () => {
    expect(deepLink({ ...base, provider: 'github', lineStart: 10, lineEnd: 20 })).toBe(
      'https://github.com/acme/billing/blob/abc123/src/invoice.ts#L10-L20',
    )
  })

  it('TASK-3 AC3: a GitLab link uses its own separator and range syntax', () => {
    // GitLab needs the `-` between the project path and the route; without it
    // a repository whose name collides with a route segment resolves to the
    // wrong page. And its range is `#L10-20`, not `#L10-L20`.
    expect(deepLink({ ...base, provider: 'gitlab', lineStart: 10, lineEnd: 20 })).toBe(
      'https://gitlab.com/acme/billing/-/blob/abc123/src/invoice.ts#L10-20',
    )
  })

  it('TASK-3 AC3: a single line is not written as a range', () => {
    expect(deepLink({ ...base, provider: 'github', lineStart: 7, lineEnd: 7 })).toContain('#L7')
    expect(deepLink({ ...base, provider: 'github', lineStart: 7, lineEnd: 7 })).not.toContain('-L7')
  })

  it('TASK-3 AC3: a pointer with no lines links to the file, not to line zero', () => {
    expect(deepLink({ ...base, provider: 'github' })).toBe(
      'https://github.com/acme/billing/blob/abc123/src/invoice.ts',
    )
  })

  it('TASK-3 AC3: characters that would break a URL are encoded, and slashes are not', () => {
    // A space, a `#` and a non-ASCII character in one path. Encoding the whole
    // path in one call would escape the separators and produce a URL that
    // opens nothing; encoding nothing produces one that truncates at the `#`.
    const link = deepLink({
      provider: 'github',
      fullName: 'acme/billing',
      path: 'src/facturación/my file#2.ts',
      commitSha: 'abc123',
    })

    expect(link).toContain('/blob/abc123/src/')
    expect(link).toContain('my%20file%232.ts')
    expect(link).toContain('facturaci%C3%B3n')
    // The directory separators survive, or the link points at a file that does
    // not exist.
    expect(link.split('/blob/abc123/')[1]).toContain('/')
  })

  it('TASK-3 AC3: without a commit it falls back to the branch, and says which', () => {
    // A branch link means "wherever this file is now", which is the opposite of
    // what a pointer is for — but it beats no link at all when the commit was
    // never recorded.
    expect(
      deepLink({
        provider: 'github',
        fullName: 'acme/billing',
        path: 'src/a.ts',
        commitSha: null,
        defaultBranch: 'develop',
      }),
    ).toContain('/blob/develop/')
  })

  it('TASK-3 AC3: an unknown provider produces a path, never a guessed URL', () => {
    // Guessing at a hosting scheme yields a link that looks right and is not,
    // which is precisely the failure this requirement exists to prevent.
    const link = deepLink({ ...base, provider: 'bitbucket' })
    expect(link).not.toMatch(/^https?:/)
    expect(link).toContain('acme/billing')
  })

  it('TASK-3 AC6: a source arriving over the wire is checked, not trusted', () => {
    expect(isPointerSource('generated')).toBe(true)
    expect(isPointerSource('manual')).toBe(true)
    expect(isPointerSource('capture')).toBe(true)
    expect(isPointerSource('invented')).toBe(false)
  })

  it('TASK-3 AC2: the confidence floor is high, because the costs are not symmetric', () => {
    // A missing pointer costs a reader one search. A wrong one costs the
    // credibility of every pointer in the product. The threshold should read
    // as cautious, and a change to it should look deliberate.
    expect(MIN_POINTER_CONFIDENCE).toBeGreaterThanOrEqual(0.5)
    expect(MIN_POINTER_CONFIDENCE).toBeLessThan(1)
  })
})
