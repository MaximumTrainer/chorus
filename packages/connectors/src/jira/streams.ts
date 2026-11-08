import type { EntityCandidate, Signal } from '@chorus/core'
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

/** The deterministic entities a Jira issue plainly states exist (INT-8). */
export function candidatesFor(signal: Signal): readonly EntityCandidate[] {
  if (signal.kind !== 'issue') return []
  const issue = (signal.raw ?? {}) as JiraIssue
  const fields = issue.fields ?? {}
  const evidence = { signalExternalId: signal.externalId, source: signal.source }
  const candidates: EntityCandidate[] = []

  // The issue itself. An epic is a Feature; anything else is a Ticket.
  const isEpic = (fields.issuetype?.name ?? '').toLowerCase() === 'epic'
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
    },
    evidence,
  })

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
