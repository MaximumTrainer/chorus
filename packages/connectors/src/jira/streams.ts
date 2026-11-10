import type { EdgeCandidate, EdgeKind, EntityCandidate, Signal } from '@chorus/core'
import { adfToMarkdown, type AdfNode } from './adf.js'

/**
 * Mapping a Jira issue to a Signal and its deterministic entities (INT-8).
 *
 * Jira is REST, not GraphQL, so a request is identified by its path and query
 * rather than a document; the mapping lives here, away from the HTTP, so the
 * same function serves the pull and (later) the webhook path and the two cannot
 * drift. Descriptions and comments are ADF, converted to Markdown at
 * normalisation so everything downstream works in one format.
 */

interface JiraUser {
  readonly accountId?: string
  readonly displayName?: string
  readonly emailAddress?: string
}

/** One entry of a Jira issue's `issuelinks`, naming the type and the other end. */
export interface JiraIssueLink {
  readonly type?: { readonly name?: string; readonly inward?: string; readonly outward?: string }
  readonly inwardIssue?: { readonly key?: string }
  readonly outwardIssue?: { readonly key?: string }
}

/** One comment on a Jira issue, its body in ADF. */
export interface JiraComment {
  readonly id: string
  readonly author?: JiraUser | null
  readonly body?: AdfNode | null
  readonly created?: string
  readonly updated?: string
}

export interface JiraIssue {
  readonly id: string
  readonly key: string
  readonly fields?: {
    readonly summary?: string
    readonly description?: AdfNode | null
    readonly status?: { readonly name?: string }
    readonly issuetype?: { readonly name?: string; readonly subtask?: boolean }
    readonly assignee?: JiraUser | null
    readonly reporter?: JiraUser | null
    readonly project?: { readonly key?: string; readonly id?: string }
    readonly updated?: string
    readonly parent?: { readonly key?: string } | null
    readonly issuelinks?: readonly JiraIssueLink[]
    readonly comment?: { readonly comments?: readonly JiraComment[] }
    readonly components?: readonly { readonly id?: string; readonly name?: string }[]
    readonly fixVersions?: readonly { readonly id?: string; readonly name?: string }[]
    readonly sprint?: readonly { readonly name?: string; readonly state?: string }[]
  }
}

function person(user: JiraUser | null | undefined): Signal['author'] {
  if (!user || typeof user.accountId !== 'string') return null
  return { externalId: user.accountId, display: user.displayName ?? user.accountId }
}

/**
 * A Jira project's issues are visible to its members. We cannot read the
 * membership from the issue, so a private project is scoped to the project id
 * and a public one is open — under-restricting would surface an issue to people
 * who cannot see it, which is the unrecoverable direction.
 */
function scope(projectId: string | undefined, restricted: boolean): Signal['permissions'] {
  return restricted && projectId
    ? { visibility: 'restricted', scopeIds: [`jira:project:${projectId}`] }
    : { visibility: 'public', scopeIds: [] }
}

export function issueToSignal(issue: JiraIssue, baseUrl: string, restricted: boolean): Signal {
  const fields = issue.fields ?? {}
  const description = fields.description ? adfToMarkdown(fields.description) : null
  return {
    source: 'jira',
    externalId: `jira:issue:${issue.key}`,
    kind: 'issue',
    text: description && description.trim() !== '' ? description : (fields.summary ?? null),
    structured: {
      summary: fields.summary ?? null,
      state: fields.status?.name ?? null,
      type: fields.issuetype?.name ?? null,
      project: fields.project?.key ?? null,
      parent: fields.parent?.key ?? null,
    },
    author: person(fields.reporter) ?? person(fields.assignee),
    occurredAt: fields.updated ? new Date(fields.updated) : new Date(0),
    url: `${baseUrl.replace(/\/$/, '')}/browse/${issue.key}`,
    permissions: scope(fields.project?.id, restricted),
    raw: issue,
  }
}

/**
 * A Jira issue's comments as their own signals (INT-8 source).
 *
 * A comment is evidence authored by a person, not an entity, so it rides the
 * same ingestion path as the issue — one signal each, scoped to the issue it
 * belongs to, its ADF body converted to Markdown like the description. The
 * commenter becomes a `person` in the deterministic pass.
 */
export function commentsFrom(issue: JiraIssue, baseUrl: string, restricted: boolean): readonly Signal[] {
  const fields = issue.fields ?? {}
  const comments = fields.comment?.comments ?? []
  const base = baseUrl.replace(/\/$/, '')
  return comments.map((comment) => {
    const body = comment.body ? adfToMarkdown(comment.body) : null
    const when = comment.updated ?? comment.created
    return {
      source: 'jira',
      externalId: `jira:comment:${comment.id}`,
      kind: 'comment',
      text: body && body.trim() !== '' ? body : null,
      structured: { issue: issue.key },
      author: person(comment.author),
      occurredAt: when ? new Date(when) : new Date(0),
      url: `${base}/browse/${issue.key}?focusedCommentId=${comment.id}`,
      permissions: scope(fields.project?.id, restricted),
      raw: comment,
    }
  })
}

/** The deterministic entities a Jira signal plainly states exist (INT-8). */
export function candidatesFor(signal: Signal): readonly EntityCandidate[] {
  const evidence = { signalExternalId: signal.externalId, source: signal.source }

  // A comment states its author is a person; the comment itself is evidence,
  // not an entity.
  if (signal.kind === 'comment') {
    const comment = (signal.raw ?? {}) as JiraComment
    const user = comment.author
    if (!user || typeof user.accountId !== 'string') return []
    return [
      {
        kind: 'person',
        externalId: `jira:user:${user.accountId}`,
        name: user.displayName ?? user.accountId,
        aliases: user.emailAddress ? [user.emailAddress] : [],
        attributes: {},
        evidence,
      },
    ]
  }

  if (signal.kind !== 'issue') return []
  const issue = (signal.raw ?? {}) as JiraIssue
  const fields = issue.fields ?? {}
  const candidates: EntityCandidate[] = []

  // The issue itself. An epic is a Feature; anything else is a Ticket. Sprints
  // and fix versions ride as release attributes rather than their own entities.
  const isEpic = (fields.issuetype?.name ?? '').toLowerCase() === 'epic'
  const versions = (fields.fixVersions ?? []).map((v) => v.name).filter((n): n is string => Boolean(n))
  const sprints = (fields.sprint ?? []).map((s) => s.name).filter((n): n is string => Boolean(n))
  candidates.push({
    kind: isEpic ? 'feature' : 'ticket',
    externalId: `jira:issue:${issue.key}`,
    name: fields.summary ?? issue.key,
    aliases: [issue.key],
    attributes: {
      state: fields.status?.name ?? null,
      type: fields.issuetype?.name ?? null,
      project: fields.project?.key ?? null,
      url: signal.url,
      ...(versions.length ? { versions } : {}),
      ...(sprints.length ? { sprints } : {}),
    },
    evidence,
  })

  // Each component the issue names is a Component entity.
  for (const component of fields.components ?? []) {
    if (!component.id) continue
    candidates.push({
      kind: 'component',
      externalId: `jira:component:${component.id}`,
      name: component.name ?? component.id,
      aliases: [],
      attributes: { project: fields.project?.key ?? null },
      evidence,
    })
  }

  // Everyone the issue names is a person.
  for (const user of [fields.assignee, fields.reporter]) {
    if (!user || typeof user.accountId !== 'string') continue
    candidates.push({
      kind: 'person',
      externalId: `jira:user:${user.accountId}`,
      name: user.displayName ?? user.accountId,
      aliases: user.emailAddress ? [user.emailAddress] : [],
      attributes: {},
      evidence,
    })
  }

  return candidates
}

/** The edge kind a Jira link type names, or null for one this slice does not map. */
function edgeKindOf(typeName: string): EdgeKind | null {
  const name = typeName.toLowerCase()
  if (name.includes('duplicate')) return 'duplicates'
  if (name.includes('block')) return 'blocks'
  return null
}

/**
 * The `duplicates` and `blocks` edges a Jira issue's links plainly state (AC7).
 *
 * Direction follows Jira's own: an `outwardIssue` is what this issue points at
 * (this → other), an `inwardIssue` points at this (other → this). Reading it
 * the same way from either end means the link seen on both issues yields one
 * edge, not two that disagree. Deterministic, so the confidence is full; other
 * link types are left for a later slice rather than forced into `relates_to`.
 */
export function edgesFor(signal: Signal): readonly EdgeCandidate[] {
  if (signal.kind !== 'issue') return []
  const issue = (signal.raw ?? {}) as JiraIssue
  const links = issue.fields?.issuelinks ?? []
  const self = `jira:issue:${issue.key}`
  const evidence = { signalExternalId: signal.externalId, source: signal.source }
  const edges: EdgeCandidate[] = []
  for (const link of links) {
    const kind = edgeKindOf(link.type?.name ?? '')
    if (!kind) continue
    if (link.outwardIssue?.key) {
      edges.push({ kind, fromExternalId: self, toExternalId: `jira:issue:${link.outwardIssue.key}`, confidence: 1, evidence })
    } else if (link.inwardIssue?.key) {
      edges.push({ kind, fromExternalId: `jira:issue:${link.inwardIssue.key}`, toExternalId: self, confidence: 1, evidence })
    }
  }
  return edges
}
