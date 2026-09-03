import type { Signal } from '@chorus/core'

/**
 * The GitHub resources a sync walks, and how each becomes a signal (INT-2).
 *
 * Declared as data rather than as a switch, so `pull` is a loop over a list and
 * the cursor is an index into it. Adding a resource is then adding a row, and
 * the pagination and cursor logic are written once — which is the difference
 * between six streams and six subtly different implementations.
 *
 * The order is fixed and must stay fixed: a cursor is an index into it, so
 * reordering these would silently re-walk one stream and skip another.
 */

export type StreamName =
  | 'commit'
  | 'pull_request'
  | 'review'
  | 'issue'
  | 'issue_comment'
  | 'deployment'
  | 'workflow_run'

export interface Stream {
  readonly name: StreamName
  /** Appended to `/repos/{owner}/{repo}`. Never carries a query string. */
  readonly path: string
  /**
   * Stream-specific query parameters, merged with pagination by the caller.
   *
   * Kept apart from `path` rather than baked into it: concatenating a query
   * onto a path that already has one produces `?state=all?per_page=30`, which
   * GitHub reads as a single malformed parameter and answers with the default
   * page — a sync that silently returns the wrong data rather than failing.
   */
  readonly query?: Readonly<Record<string, string>>
  /** Most endpoints return an array; workflow runs wrap theirs in an object. */
  itemsOf(payload: unknown): readonly Record<string, unknown>[]
  toSignal(item: Record<string, unknown>, repository: string, isPrivate: boolean): Signal
}

const asArray = (payload: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(payload) ? (payload as Record<string, unknown>[]) : []

/**
 * Permission scope, captured at ingest (INT-2 AC7).
 *
 * A private repository's activity is restricted to those who can see the
 * repository, which retrieval re-checks. The scope id names the repository
 * rather than the installation: access is granted per repository, so an
 * installation-wide scope would leak between repositories in the same account.
 */
function scopeFor(repository: string, isPrivate: boolean): Signal['permissions'] {
  return isPrivate
    ? { visibility: 'restricted', scopeIds: [`github:repo:${repository}`] }
    : { visibility: 'public', scopeIds: [] }
}

function actor(item: Record<string, unknown>, key = 'user'): Signal['author'] {
  const raw = item[key] as { id?: unknown; login?: unknown } | null | undefined
  if (!raw || typeof raw.login !== 'string') return null
  return { externalId: String(raw.id ?? raw.login), display: raw.login }
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** A timestamp GitHub gave us, or a loud failure. Never a substituted `now`. */
function at(item: Record<string, unknown>, ...keys: string[]): Date {
  for (const key of keys) {
    const value = item[key]
    if (typeof value === 'string') {
      const parsed = new Date(value)
      if (Number.isFinite(parsed.getTime())) return parsed
    }
  }
  // Deliberately invalid rather than `now()`: the envelope refuses it, so the
  // page fails loudly instead of writing a signal misfiled forever.
  return new Date(NaN)
}

export const STREAMS: readonly Stream[] = [
  {
    name: 'commit',
    path: '/commits',
    itemsOf: asArray,
    toSignal(item, repository, isPrivate) {
      const commit = (item.commit ?? {}) as Record<string, unknown>
      const committer = (commit.author ?? {}) as Record<string, unknown>
      return {
        source: 'github',
        externalId: `${repository}@${String(item.sha)}`,
        kind: 'commit',
        text: str(commit.message),
        structured: { repository, sha: item.sha },
        author: actor(item, 'author') ?? {
          externalId: String(committer.email ?? 'unknown'),
          display: String(committer.name ?? 'unknown'),
        },
        occurredAt: at(committer, 'date'),
        url: str(item.html_url),
        permissions: scopeFor(repository, isPrivate),
        raw: item,
      }
    },
  },
  {
    name: 'pull_request',
    path: '/pulls',
    query: { state: 'all' },
    itemsOf: asArray,
    toSignal(item, repository, isPrivate) {
      return {
        source: 'github',
        externalId: `${repository}#pr-${String(item.number)}`,
        kind: 'pull_request',
        text: [str(item.title), str(item.body)].filter(Boolean).join('\n\n') || null,
        structured: {
          repository,
          number: item.number,
          state: item.state,
          merged: Boolean(item.merged_at),
          head: (item.head as { ref?: string } | undefined)?.ref ?? null,
          base: (item.base as { ref?: string } | undefined)?.ref ?? null,
        },
        author: actor(item),
        occurredAt: at(item, 'updated_at', 'created_at'),
        url: str(item.html_url),
        permissions: scopeFor(repository, isPrivate),
        raw: item,
      }
    },
  },
  {
    name: 'review',
    // Reviews hang off pull requests; this endpoint is the account-wide feed of
    // review comments, which is what a sync can walk without N+1 requests.
    path: '/pulls/comments',
    itemsOf: asArray,
    toSignal(item, repository, isPrivate) {
      return {
        source: 'github',
        externalId: `${repository}#review-comment-${String(item.id)}`,
        kind: 'review',
        text: str(item.body),
        structured: {
          repository,
          path: item.path,
          line: item.line ?? item.original_line ?? null,
          pullRequestUrl: item.pull_request_url,
        },
        author: actor(item),
        occurredAt: at(item, 'updated_at', 'created_at'),
        url: str(item.html_url),
        permissions: scopeFor(repository, isPrivate),
        raw: item,
      }
    },
  },
  {
    name: 'issue',
    path: '/issues',
    query: { state: 'all' },
    itemsOf: asArray,
    toSignal(item, repository, isPrivate) {
      return {
        source: 'github',
        externalId: `${repository}#issue-${String(item.number)}`,
        kind: 'issue',
        text: [str(item.title), str(item.body)].filter(Boolean).join('\n\n') || null,
        structured: {
          repository,
          number: item.number,
          state: item.state,
          labels: Array.isArray(item.labels)
            ? item.labels.map((label) => (label as { name?: string }).name).filter(Boolean)
            : [],
        },
        author: actor(item),
        occurredAt: at(item, 'updated_at', 'created_at'),
        url: str(item.html_url),
        permissions: scopeFor(repository, isPrivate),
        raw: item,
      }
    },
  },
  {
    name: 'issue_comment',
    path: '/issues/comments',
    itemsOf: asArray,
    toSignal(item, repository, isPrivate) {
      return {
        source: 'github',
        externalId: `${repository}#issue-comment-${String(item.id)}`,
        kind: 'issue_comment',
        text: str(item.body),
        structured: { repository, issueUrl: item.issue_url },
        author: actor(item),
        occurredAt: at(item, 'updated_at', 'created_at'),
        url: str(item.html_url),
        permissions: scopeFor(repository, isPrivate),
        raw: item,
      }
    },
  },
  {
    name: 'deployment',
    path: '/deployments',
    itemsOf: asArray,
    toSignal(item, repository, isPrivate) {
      return {
        source: 'github',
        externalId: `${repository}#deployment-${String(item.id)}`,
        kind: 'deployment',
        text: str(item.description),
        // Preview discovery (PROTO-3) reads these: which environment, which
        // commit, and where it can be reached.
        structured: {
          repository,
          environment: item.environment,
          ref: item.ref,
          sha: item.sha,
          transient: item.transient_environment ?? null,
          production: item.production_environment ?? null,
        },
        author: actor(item, 'creator'),
        occurredAt: at(item, 'updated_at', 'created_at'),
        url: str(item.url),
        permissions: scopeFor(repository, isPrivate),
        raw: item,
      }
    },
  },
  {
    name: 'workflow_run',
    path: '/actions/runs',
    itemsOf: (payload) => {
      const wrapped = payload as { workflow_runs?: unknown }
      return asArray(wrapped?.workflow_runs)
    },
    toSignal(item, repository, isPrivate) {
      return {
        source: 'github',
        externalId: `${repository}#run-${String(item.id)}`,
        kind: 'workflow_run',
        text: str(item.name),
        structured: {
          repository,
          status: item.status,
          conclusion: item.conclusion,
          headSha: item.head_sha,
          headBranch: item.head_branch,
          event: item.event,
        },
        author: actor(item, 'actor'),
        occurredAt: at(item, 'updated_at', 'created_at'),
        url: str(item.html_url),
        permissions: scopeFor(repository, isPrivate),
        raw: item,
      }
    },
  },
]

export { scopeFor, actor, at, str }
