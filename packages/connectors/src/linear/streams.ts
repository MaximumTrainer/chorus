import type { EntityCandidate, Signal } from '@chorus/core'

/**
 * The Linear resources a sync walks, and what they deterministically mean
 * (INT-2 AC5).
 *
 * Each stream carries its own GraphQL document because in GraphQL the *query*
 * is what identifies a request — there is no path to vary. Keeping the document
 * beside the mapping is what stops the two drifting: a field added to the query
 * and never read, or read and never asked for, is a bug that typechecks.
 *
 * The order is fixed and load-bearing: the cursor is an index into it.
 */

export interface LinearStream {
  readonly name: 'issue' | 'comment' | 'project' | 'cycle'
  /** Linear's webhook `type` for the same object, where it sends one. */
  readonly webhookType: string
  /** The top-level field the connection appears under. */
  readonly field: string
  readonly document: string
  readonly kind: string
  toSignal(node: Record<string, unknown>, restricted: boolean): Signal
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/**
 * Linear workspaces are private by default and have no per-object visibility we
 * can read from these queries, so everything is scoped to the organisation.
 * Under-restricting would surface a tracker to people who cannot see it.
 */
function scope(restricted: boolean): Signal['permissions'] {
  return restricted
    ? { visibility: 'restricted', scopeIds: ['linear:organisation'] }
    : { visibility: 'public', scopeIds: [] }
}

function person(node: Record<string, unknown>, key: string): Signal['author'] {
  const raw = node[key] as { id?: unknown; name?: unknown; displayName?: unknown } | null | undefined
  if (!raw || typeof raw.id !== 'string') return null
  const display = typeof raw.displayName === 'string' ? raw.displayName : raw.name
  return { externalId: raw.id, display: typeof display === 'string' ? display : raw.id }
}

function at(node: Record<string, unknown>, ...keys: string[]): Date {
  for (const key of keys) {
    const value = node[key]
    if (typeof value === 'string') {
      const parsed = new Date(value)
      if (Number.isFinite(parsed.getTime())) return parsed
    }
  }
  return new Date(NaN)
}

const PAGE_ARGS = '($first: Int!, $after: String)'
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }'

export const LINEAR_STREAMS: readonly LinearStream[] = [
  {
    name: 'issue',
    webhookType: 'Issue',
    field: 'issues',
    kind: 'issue',
    document: `query Issues${PAGE_ARGS} {
  issues(first: $first, after: $after, orderBy: updatedAt) {
    ${PAGE_INFO}
    nodes {
      id identifier title description url createdAt updatedAt
      state { name type }
      team { id key name }
      creator { id name displayName }
      assignee { id name displayName }
      project { id name }
      cycle { id number name }
    }
  }
}`,
    toSignal(node, restricted) {
      return {
        source: 'linear',
        // The human-facing identifier (`ACME-7`), not the UUID: an external id
        // nobody can match against what they are looking at is one nobody will
        // trust when it appears in a citation.
        externalId: `linear:issue:${String(node.identifier ?? node.id)}`,
        kind: 'issue',
        text: [str(node.title), str(node.description)].filter(Boolean).join('\n\n') || null,
        structured: {
          identifier: node.identifier,
          state: (node.state as { name?: string } | undefined)?.name ?? null,
          stateType: (node.state as { type?: string } | undefined)?.type ?? null,
          team: (node.team as { key?: string } | undefined)?.key ?? null,
          project: (node.project as { name?: string } | undefined)?.name ?? null,
          cycle: (node.cycle as { number?: number } | undefined)?.number ?? null,
          assignee: (node.assignee as { displayName?: string } | undefined)?.displayName ?? null,
        },
        author: person(node, 'creator'),
        occurredAt: at(node, 'updatedAt', 'createdAt'),
        url: str(node.url),
        permissions: scope(restricted),
        raw: node,
      }
    },
  },
  {
    name: 'comment',
    webhookType: 'Comment',
    field: 'comments',
    kind: 'issue_comment',
    document: `query Comments${PAGE_ARGS} {
  comments(first: $first, after: $after) {
    ${PAGE_INFO}
    nodes {
      id body url createdAt updatedAt
      user { id name displayName }
      issue { id identifier }
    }
  }
}`,
    toSignal(node, restricted) {
      return {
        source: 'linear',
        externalId: `linear:comment:${String(node.id)}`,
        kind: 'issue_comment',
        text: str(node.body),
        structured: {
          issue: (node.issue as { identifier?: string } | undefined)?.identifier ?? null,
        },
        author: person(node, 'user'),
        occurredAt: at(node, 'updatedAt', 'createdAt'),
        url: str(node.url),
        permissions: scope(restricted),
        raw: node,
      }
    },
  },
  {
    name: 'project',
    webhookType: 'Project',
    field: 'projects',
    kind: 'project',
    document: `query Projects${PAGE_ARGS} {
  projects(first: $first, after: $after) {
    ${PAGE_INFO}
    nodes {
      id name description url state createdAt updatedAt targetDate
      lead { id name displayName }
    }
  }
}`,
    toSignal(node, restricted) {
      return {
        source: 'linear',
        externalId: `linear:project:${String(node.id)}`,
        kind: 'project',
        text: [str(node.name), str(node.description)].filter(Boolean).join('\n\n') || null,
        structured: { state: node.state ?? null, targetDate: node.targetDate ?? null },
        author: person(node, 'lead'),
        occurredAt: at(node, 'updatedAt', 'createdAt'),
        url: str(node.url),
        permissions: scope(restricted),
        raw: node,
      }
    },
  },
  {
    name: 'cycle',
    webhookType: 'Cycle',
    field: 'cycles',
    kind: 'cycle',
    document: `query Cycles${PAGE_ARGS} {
  cycles(first: $first, after: $after) {
    ${PAGE_INFO}
    nodes {
      id number name startsAt endsAt createdAt updatedAt
      team { id key name }
    }
  }
}`,
    toSignal(node, restricted) {
      return {
        source: 'linear',
        externalId: `linear:cycle:${String(node.id)}`,
        kind: 'cycle',
        text: str(node.name),
        structured: {
          number: node.number ?? null,
          startsAt: node.startsAt ?? null,
          endsAt: node.endsAt ?? null,
          team: (node.team as { key?: string } | undefined)?.key ?? null,
        },
        author: null,
        occurredAt: at(node, 'updatedAt', 'createdAt'),
        url: null,
        permissions: scope(restricted),
        raw: node,
      }
    },
  },
]

export function toSignal(
  stream: LinearStream,
  node: Record<string, unknown>,
  restricted: boolean,
): Signal {
  return stream.toSignal(node, restricted)
}

/**
 * What a Linear signal plainly says exists (INT-2 AC5).
 *
 * Nothing is inferred: an issue *is* a ticket because Linear says so, and its
 * creator *is* a person because the payload names one. That is the whole of the
 * deterministic pass, and the reason it beats a model call — there is nothing
 * to be uncertain about, so certainty is free.
 */
export function candidatesFor(signal: Signal): readonly EntityCandidate[] {
  const evidence = { signalExternalId: signal.externalId, source: signal.source }
  const candidates: EntityCandidate[] = []
  const raw = (signal.raw ?? {}) as Record<string, unknown>

  if (signal.kind === 'issue') {
    const identifier = String(raw.identifier ?? '')
    candidates.push({
      kind: 'ticket',
      externalId: `linear:issue:${identifier || String(raw.id ?? '')}`,
      name: String(raw.title ?? identifier),
      // The short code is how people refer to it in conversation, so it has to
      // resolve as an alias or every mention becomes a new entity.
      aliases: identifier ? [identifier] : [],
      attributes: {
        state: (raw.state as { name?: string } | undefined)?.name ?? null,
        team: (raw.team as { key?: string } | undefined)?.key ?? null,
        url: signal.url,
      },
      evidence,
    })
  }

  if (signal.kind === 'project') {
    candidates.push({
      kind: 'feature',
      externalId: `linear:project:${String(raw.id ?? '')}`,
      name: String(raw.name ?? 'Untitled project'),
      aliases: [],
      attributes: { state: raw.state ?? null, url: signal.url },
      evidence,
    })
  }

  // Every payload that names a person yields one, whichever stream it came
  // from: a commenter is as real as an issue's creator.
  for (const key of ['creator', 'assignee', 'user', 'lead']) {
    const actor = raw[key] as { id?: unknown; name?: unknown; displayName?: unknown } | undefined
    if (!actor || typeof actor.id !== 'string') continue
    const display = typeof actor.displayName === 'string' ? actor.displayName : actor.name
    candidates.push({
      kind: 'person',
      externalId: `linear:user:${actor.id}`,
      name: typeof actor.name === 'string' ? actor.name : String(display ?? actor.id),
      aliases: typeof display === 'string' && display !== actor.name ? [display] : [],
      attributes: {},
      evidence,
    })
  }

  // Deduplicated within one signal: an issue whose creator is also its assignee
  // must not yield the same person twice.
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = `${candidate.kind}:${candidate.externalId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
