/**
 * Code pointers (TASK-3, architecture.md §8.2).
 *
 * > A pointer that does not resolve is worse than none: it teaches everyone,
 * > human and machine, to distrust all of them.
 *
 * That sentence sets the whole design. A pointer is only created after being
 * checked against the index, a low-confidence match produces nothing rather
 * than a guess, and a pointer whose file has moved is marked stale rather than
 * quietly linking somewhere wrong.
 */

/**
 * Where a pointer came from.
 *
 * `manual` is the one with rights: regeneration replaces `generated` pointers
 * and leaves the others alone, because a person who corrected a pointer has
 * told us something the index does not know.
 */
export const POINTER_SOURCES = ['generated', 'capture', 'manual'] as const
export type PointerSource = (typeof POINTER_SOURCES)[number]

export function isPointerSource(value: unknown): value is PointerSource {
  return typeof value === 'string' && (POINTER_SOURCES as readonly string[]).includes(value)
}

/**
 * How relevant a match must be before it becomes a pointer.
 *
 * The asymmetry from the rationale, made a number: a missing pointer costs a
 * reader a search, while a wrong one costs the credibility of every other
 * pointer in the product. So this sits deliberately high, and AC2 asserts that
 * a task with no confident match gets nothing at all.
 */
export const MIN_POINTER_CONFIDENCE = 0.5

export interface CodePointer {
  readonly id: string
  readonly taskId: string
  readonly repositoryId: string
  readonly path: string
  readonly symbolName: string | null
  readonly lineStart: number
  readonly lineEnd: number
  /** The commit the pointer was validated against, so a link is reproducible. */
  readonly commitSha: string | null
  readonly source: PointerSource
  readonly confidence: number
  /**
   * When the file stopped resolving, if it has.
   *
   * Marked rather than deleted (AC5): the last known good commit still links,
   * which is more useful than an absence — somebody can see what it *used* to
   * point at and where it went.
   */
  readonly staleAt: string | null
}

export interface DeepLinkTarget {
  readonly provider: string
  /** `owner/name`, as the provider writes it. */
  readonly fullName: string
  readonly path: string
  readonly commitSha?: string | null
  readonly defaultBranch?: string
  readonly lineStart?: number
  readonly lineEnd?: number
}

/**
 * A URL that opens the file at the right commit and lines.
 *
 * Pinned to a commit wherever one is known, and to the branch only as a
 * fallback. A link to a branch says "wherever this file is now", which is the
 * opposite of what a pointer means — the reviewer needs to see what the task
 * was written against, not what it drifted into.
 *
 * Path segments are encoded individually so a directory separator survives and
 * everything else — spaces, `#`, `?`, non-ASCII — does not break the URL.
 */
export function deepLink(target: DeepLinkTarget): string {
  const ref = target.commitSha ?? target.defaultBranch ?? 'HEAD'
  const path = target.path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')

  switch (target.provider) {
    case 'github':
      return `https://github.com/${target.fullName}/blob/${ref}/${path}${gitHubLines(target)}`
    case 'gitlab':
      // GitLab needs the `-` separator between the project path and the route;
      // without it a repository whose name collides with a route segment
      // resolves to the wrong page.
      return `https://gitlab.com/${target.fullName}/-/blob/${ref}/${path}${gitLabLines(target)}`
    default:
      // An unknown provider gets a path rather than a wrong URL. Guessing at a
      // hosting scheme would produce a link that looks right and is not, which
      // is the failure this requirement exists to prevent.
      return `${target.fullName}/${path}`
  }
}

function gitHubLines(target: DeepLinkTarget): string {
  if (!target.lineStart) return ''
  return target.lineEnd && target.lineEnd !== target.lineStart
    ? `#L${target.lineStart}-L${target.lineEnd}`
    : `#L${target.lineStart}`
}

function gitLabLines(target: DeepLinkTarget): string {
  if (!target.lineStart) return ''
  return target.lineEnd && target.lineEnd !== target.lineStart
    ? `#L${target.lineStart}-${target.lineEnd}`
    : `#L${target.lineStart}`
}
