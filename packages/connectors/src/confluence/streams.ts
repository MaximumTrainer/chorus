import type { EntityCandidate, Signal } from '@chorus/core'
import { confluenceToMarkdown } from './body.js'
import type { AdfNode } from '../jira/adf.js'

/**
 * Mapping a Confluence page to a Signal and its deterministic entities (INT-9).
 *
 * A page is evidence authored by a person; the page itself is a Page entity,
 * its space a topic container for brain-map grouping, and its author a Person.
 * Bodies are ADF (ADR-0022), carried as a stringified document in
 * `body.atlas_doc_format.value`, converted to Markdown with macros resolved so
 * everything downstream works in one format.
 */

interface ConfluenceUser {
  readonly accountId?: string
  readonly displayName?: string
  readonly email?: string
}

export interface ConfluencePage {
  readonly id: string
  readonly type?: string
  readonly title?: string
  readonly space?: { readonly id?: number | string; readonly key?: string; readonly name?: string }
  readonly history?: { readonly createdBy?: ConfluenceUser }
  readonly version?: { readonly number?: number; readonly when?: string; readonly by?: ConfluenceUser }
  readonly body?: { readonly atlas_doc_format?: { readonly value?: string } }
  readonly _links?: { readonly webui?: string }
  readonly restrictions?: {
    readonly read?: {
      readonly restrictions?: {
        readonly user?: { readonly results?: readonly { readonly accountId?: string }[] }
        readonly group?: { readonly results?: readonly { readonly name?: string }[] }
      }
    }
  }
}

function person(user: ConfluenceUser | undefined): Signal['author'] {
  if (!user || typeof user.accountId !== 'string') return null
  return { externalId: user.accountId, display: user.displayName ?? user.accountId }
}

/**
 * A page's read permission (AC4).
 *
 * A page can be restricted to specific groups or users; that restriction is the
 * narrowest and wins — the signal is scoped to exactly those readers, so a
 * person outside them cannot retrieve it. Absent a page restriction we fall back
 * to the space: a space's pages are visible to its members, and absent that
 * membership we scope to the space id rather than under-restricting.
 */
function scope(page: ConfluencePage, restricted: boolean): Signal['permissions'] {
  const read = page.restrictions?.read?.restrictions
  const groups = (read?.group?.results ?? []).map((g) => g.name).filter((n): n is string => Boolean(n))
  const users = (read?.user?.results ?? []).map((u) => u.accountId).filter((a): a is string => Boolean(a))
  const pageScopes = [...groups.map((g) => `confluence:group:${g}`), ...users.map((u) => `confluence:user:${u}`)]
  if (pageScopes.length > 0) {
    return { visibility: 'restricted', scopeIds: pageScopes }
  }
  const spaceId = page.space?.id
  return restricted && spaceId !== undefined
    ? { visibility: 'restricted', scopeIds: [`confluence:space:${spaceId}`] }
    : { visibility: 'public', scopeIds: [] }
}

/** Parse the stringified ADF body, or null when it is absent or malformed. */
function parseBody(page: ConfluencePage): AdfNode | null {
  const raw = page.body?.atlas_doc_format?.value
  if (!raw) return null
  try {
    return JSON.parse(raw) as AdfNode
  } catch {
    // A body we cannot parse is not a reason to drop the page; its title stands.
    return null
  }
}

export function pageToSignal(page: ConfluencePage, baseUrl: string, restricted: boolean): Signal {
  const body = parseBody(page)
  const markdown = body ? confluenceToMarkdown(body) : null
  const base = baseUrl.replace(/\/$/, '')
  return {
    source: 'confluence',
    externalId: `confluence:page:${page.id}`,
    kind: page.type === 'blogpost' ? 'blogpost' : 'page',
    text: markdown && markdown.trim() !== '' ? markdown : (page.title ?? null),
    structured: {
      title: page.title ?? null,
      space: page.space?.key ?? null,
      type: page.type ?? 'page',
    },
    author: person(page.version?.by) ?? person(page.history?.createdBy),
    occurredAt: page.version?.when ? new Date(page.version.when) : new Date(0),
    url: `${base}/wiki${page._links?.webui ?? ''}`,
    permissions: scope(page, restricted),
    raw: page,
  }
}

/** The deterministic entities a Confluence page plainly states exist (INT-9). */
export function candidatesFor(signal: Signal): readonly EntityCandidate[] {
  if (signal.kind !== 'page' && signal.kind !== 'blogpost') return []
  const page = (signal.raw ?? {}) as ConfluencePage
  const evidence = { signalExternalId: signal.externalId, source: signal.source }
  const candidates: EntityCandidate[] = [
    {
      kind: 'page',
      externalId: `confluence:page:${page.id}`,
      name: page.title ?? page.id,
      aliases: [],
      attributes: {
        space: page.space?.key ?? null,
        type: page.type ?? 'page',
        url: signal.url,
      },
      evidence,
    },
  ]

  // The space is a topic container used for brain-map grouping.
  if (page.space?.key) {
    candidates.push({
      kind: 'topic',
      externalId: `confluence:space:${page.space.key}`,
      name: page.space.name ?? page.space.key,
      aliases: [],
      attributes: {},
      evidence,
    })
  }

  // The author is a person.
  const author = page.version?.by ?? page.history?.createdBy
  if (author?.accountId) {
    candidates.push({
      kind: 'person',
      externalId: `confluence:user:${author.accountId}`,
      name: author.displayName ?? author.accountId,
      aliases: author.email ? [author.email] : [],
      attributes: {},
      evidence,
    })
  }

  return candidates
}
