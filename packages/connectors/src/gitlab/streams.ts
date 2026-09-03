import type { Signal } from '@chorus/core'

/**
 * The GitLab resources a sync walks (INT-2).
 *
 * Same shape as the GitHub stream table, deliberately, so the framework's
 * pagination and cursor handling stay provider-agnostic. Where GitLab differs
 * the difference lives in the row, not in the loop — which is the whole reason
 * for building the second provider before declaring the first one's design
 * general.
 *
 * The order is fixed and load-bearing: the cursor is an index into it.
 */

export type GitLabStreamName =
  | 'commit'
  | 'merge_request'
  | 'review'
  | 'issue'
  | 'issue_comment'
  | 'deployment'
  | 'pipeline'

export interface GitLabStream {
  readonly name: GitLabStreamName
  /** Appended to `/projects/{encoded}`. Never carries a query string. */
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  itemsOf(payload: unknown): readonly Record<string, unknown>[]
  toSignal(item: Record<string, unknown>, project: string, isPrivate: boolean): Signal
}

const asArray = (payload: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(payload) ? (payload as Record<string, unknown>[]) : []

/** Scope names the project, for the same reason GitHub's names the repository. */
export function scopeFor(project: string, isPrivate: boolean): Signal['permissions'] {
  return isPrivate
    ? { visibility: 'restricted', scopeIds: [`gitlab:project:${project}`] }
    : { visibility: 'public', scopeIds: [] }
}

export function actor(item: Record<string, unknown>, key = 'author'): Signal['author'] {
  const raw = item[key] as { id?: unknown; username?: unknown; name?: unknown } | null | undefined
  if (!raw) return null
  const display = typeof raw.username === 'string' ? raw.username : raw.name
  if (typeof display !== 'string') return null
  return { externalId: String(raw.id ?? display), display }
}

export const str = (value: unknown): string | null =>
  typeof value === 'string' ? value : null

/**
 * A timestamp GitLab gave us.
 *
 * GitLab is inconsistent about format: the REST API returns ISO-8601, but
 * webhook payloads use `2026-09-01 09:00:00 UTC`, which `Date` cannot parse.
 * Normalising here rather than in each mapping is why this is one function —
 * and getting it wrong would misfile every webhook-sourced signal while the
 * pulled ones looked fine.
 */
export function at(item: Record<string, unknown>, ...keys: string[]): Date {
  for (const key of keys) {
    const value = item[key]
    if (typeof value !== 'string') continue

    const direct = new Date(value)
    if (Number.isFinite(direct.getTime())) return direct

    const webhookFormat = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/.exec(value)
    if (webhookFormat) {
      const parsed = new Date(`${webhookFormat[1]}T${webhookFormat[2]}Z`)
      if (Number.isFinite(parsed.getTime())) return parsed
    }
  }
  // Invalid rather than `now()`: the envelope refuses it, so the page fails
  // loudly instead of writing a signal misfiled forever.
  return new Date(NaN)
}

export const GITLAB_STREAMS: readonly GitLabStream[] = [
  {
    name: 'commit',
    path: '/repository/commits',
    itemsOf: asArray,
    toSignal(item, project, isPrivate) {
      return {
        source: 'gitlab',
        externalId: `${project}@${String(item.id)}`,
        kind: 'commit',
        text: str(item.message),
        structured: { project, sha: item.id, shortId: item.short_id },
        author:
          typeof item.author_email === 'string'
            ? {
                externalId: item.author_email,
                display: String(item.author_name ?? item.author_email),
              }
            : null,
        occurredAt: at(item, 'committed_date', 'created_at'),
        url: str(item.web_url),
        permissions: scopeFor(project, isPrivate),
        raw: item,
      }
    },
  },
  {
    name: 'merge_request',
    path: '/merge_requests',
    query: { state: 'all', scope: 'all' },
    itemsOf: asArray,
    toSignal(item, project, isPrivate) {
      return {
        source: 'gitlab',
        // `iid` — the per-project number — not `id`, which is instance-wide.
        // Using `id` would make external ids unrecognisable to anyone reading
        // them against the GitLab UI.
        externalId: `${project}#mr-${String(item.iid)}`,
        kind: 'merge_request',
        text: [str(item.title), str(item.description)].filter(Boolean).join('\n\n') || null,
        structured: {
          project,
          iid: item.iid,
          state: item.state,
          merged: item.state === 'merged',
          head: item.source_branch ?? null,
          base: item.target_branch ?? null,
        },
        author: actor(item),
        occurredAt: at(item, 'updated_at', 'created_at'),
        url: str(item.web_url),
        permissions: scopeFor(project, isPrivate),
        raw: item,
      }
    },
  },
  {
    name: 'review',
    // GitLab has no account-wide review-comment feed; the merge-request notes
    // endpoint for the project is the nearest equivalent a sync can walk.
    path: '/merge_requests/notes',
    itemsOf: asArray,
    toSignal(item, project, isPrivate) {
      return {
        source: 'gitlab',
        externalId: `${project}#mr-note-${String(item.id)}`,
        kind: 'review',
        text: str(item.body),
        structured: {
          project,
          noteableIid: item.noteable_iid ?? null,
          path: (item.position as { new_path?: string } | undefined)?.new_path ?? null,
        },
        author: actor(item),
        occurredAt: at(item, 'updated_at', 'created_at'),
        url: null,
        permissions: scopeFor(project, isPrivate),
        raw: item,
      }
    },
  },
  {
    name: 'issue',
    path: '/issues',
    query: { state: 'all', scope: 'all' },
    itemsOf: asArray,
    toSignal(item, project, isPrivate) {
      return {
        source: 'gitlab',
        externalId: `${project}#issue-${String(item.iid)}`,
        kind: 'issue',
        text: [str(item.title), str(item.description)].filter(Boolean).join('\n\n') || null,
        structured: {
          project,
          iid: item.iid,
          state: item.state,
          labels: Array.isArray(item.labels) ? item.labels : [],
        },
        author: actor(item),
        occurredAt: at(item, 'updated_at', 'created_at'),
        url: str(item.web_url),
        permissions: scopeFor(project, isPrivate),
        raw: item,
      }
    },
  },
  {
    name: 'issue_comment',
    path: '/issues/notes',
    itemsOf: asArray,
    toSignal(item, project, isPrivate) {
      return {
        source: 'gitlab',
        externalId: `${project}#issue-note-${String(item.id)}`,
        kind: 'issue_comment',
        text: str(item.body),
        structured: { project, noteableIid: item.noteable_iid ?? null },
        author: actor(item),
        occurredAt: at(item, 'updated_at', 'created_at'),
        url: null,
        permissions: scopeFor(project, isPrivate),
        raw: item,
      }
    },
  },
  {
    name: 'deployment',
    path: '/deployments',
    itemsOf: asArray,
    toSignal(item, project, isPrivate) {
      const deployable = (item.deployable ?? {}) as Record<string, unknown>
      const commit = (deployable.commit ?? {}) as Record<string, unknown>
      return {
        source: 'gitlab',
        externalId: `${project}#deployment-${String(item.id)}`,
        kind: 'deployment',
        text: null,
        // The same three facts preview discovery reads from GitHub's:
        // environment, ref, commit.
        structured: {
          project,
          environment: (item.environment as { name?: string } | undefined)?.name ?? null,
          ref: item.ref ?? deployable.ref ?? null,
          sha: item.sha ?? commit.id ?? null,
          status: item.status,
        },
        author: actor(item, 'user'),
        occurredAt: at(item, 'updated_at', 'created_at'),
        url: str(commit.web_url),
        permissions: scopeFor(project, isPrivate),
        raw: item,
      }
    },
  },
  {
    name: 'pipeline',
    path: '/pipelines',
    itemsOf: asArray,
    toSignal(item, project, isPrivate) {
      return {
        source: 'gitlab',
        externalId: `${project}#pipeline-${String(item.id)}`,
        kind: 'workflow_run',
        text: null,
        // Mapped onto the same signal kind as a GitHub workflow run, with the
        // same field names, so anything downstream reads one shape rather than
        // learning both providers' vocabularies.
        structured: {
          project,
          status: item.status,
          conclusion: item.status,
          headSha: item.sha,
          headBranch: item.ref,
          event: item.source ?? null,
        },
        author: actor(item, 'user'),
        occurredAt: at(item, 'updated_at', 'created_at'),
        url: str(item.web_url),
        permissions: scopeFor(project, isPrivate),
        raw: item,
      }
    },
  },
]
