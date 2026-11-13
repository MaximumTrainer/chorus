import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'
import { STALE_AFTER_DAYS } from './self-organise.js'
import { viewerScopes as resolveViewerScopes } from './scope-memberships.js'

/**
 * The brain map's read model (BRAIN-6).
 *
 * An interactive graph of entities and the edges between them. This is the
 * server half: the nodes and edges, permission-filtered, that the client lays
 * out and renders. Layout is computed on the client — sending positions from
 * the server fixes the layout and makes filtering feel broken — so this returns
 * no coordinates.
 *
 * **The map is not an exemption from retrieval's permission rules (AC6).** An
 * aggregate view leaks exactly as a list does: an entity derived solely from a
 * source the caller cannot see must be absent, not merely unlabelled. So an
 * entity is a node only when it has at least one piece of evidence the caller
 * is permitted to see — the same per-signal predicate the retriever applies —
 * and an edge is present only between two nodes that both survived it. With no
 * caller scopes the predicate is fail-closed: only publicly-evidenced entities
 * appear. Resolving a caller's scope ids from their memberships is
 * identity-linking, a separate concern; the map takes them so the predicate is
 * complete.
 *
 * External-authority nodes carry their `authority` and `externalUri` (BRAIN-11
 * AC7), so the client renders "authoritative in the owning source" with an
 * outbound link rather than a compiled page.
 */

export interface BrainMapNode {
  readonly id: string
  readonly kind: string
  readonly name: string
  /** Connectedness: visible evidence plus edges to other visible nodes. */
  readonly salience: number
  /** The newest visible evidence timestamp, for the client's freshness view. ISO, or null. */
  readonly lastActivityAt: string | null
  /** The freshness class the client styles (AC3) — see `BrainMapView.freshness` for its definition. */
  readonly freshness: Freshness
  readonly authority: 'brain' | 'external'
  readonly externalUri: string | null
}

export interface BrainMapEdge {
  readonly from: string
  readonly to: string
  readonly relation: string
  readonly confidence: number
}

export interface BrainMapView {
  readonly nodes: readonly BrainMapNode[]
  readonly edges: readonly BrainMapEdge[]
  /**
   * The definition every node's `freshness` was classified against, carried
   * with the data so the UI documents what "stale" means rather than leaving
   * the distinction implicit (AC3).
   */
  readonly freshness: { readonly staleAfterDays: number; readonly definition: string }
}

/** How current the map believes an entity is. `unknown` when there is nothing to judge by. */
export type Freshness = 'fresh' | 'stale' | 'unknown'

/**
 * Classify one entity's freshness (BRAIN-6 AC3).
 *
 * One definition of stale, shared with the review inbox's stale detector
 * (`STALE_AFTER_DAYS`), so the map and the inbox never disagree about the same
 * entity. A brain entity is judged by its newest visible evidence. An
 * external-authority entity is judged by its owning source's own last sync
 * (BRAIN-11 AC3): Chorus holds no evidence that could make it fresher than the
 * source says it is, nor any that should make a freshly-synced one look stale.
 * Exactly at the threshold is still fresh. With no timestamp to judge by, the
 * answer is `unknown` rather than a guess.
 */
export function classifyFreshness(
  entity: {
    readonly authority: 'brain' | 'external'
    readonly lastActivityAt: Date | null
    readonly lastSyncedAt: Date | null
  },
  now: Date,
  staleAfterDays: number = STALE_AFTER_DAYS,
): Freshness {
  const at = entity.authority === 'external' ? entity.lastSyncedAt : entity.lastActivityAt
  if (!at) return 'unknown'
  const ageDays = (now.getTime() - at.getTime()) / (24 * 60 * 60 * 1000)
  return ageDays > staleAfterDays ? 'stale' : 'fresh'
}

/** The human-readable definition of stale the map was classified against. */
function freshnessDefinition(staleAfterDays: number): string {
  return (
    `Stale means nothing has been heard about it for more than ${staleAfterDays} days: ` +
    `for an entity Chorus extracted, its newest evidence you can see is older than that; ` +
    `for one an external source owns, that source last synced it longer ago than that.`
  )
}

export interface BrainMapOptions {
  /** The clock, injected so a test decides "stale" against a fixed instant. */
  readonly now?: () => Date
  /** Defaults to the stale detector's own threshold, so the two agree. */
  readonly staleAfterDays?: number
}

/**
 * Narrowing the map (AC2). Each filter is optional and absent means "all". A
 * `source` or `since` narrows which *evidence* counts, so it also reshapes
 * `salience` and `lastActivityAt` — a node kept for evidence outside the window
 * would show numbers that do not match what is displayed.
 */
export interface BrainMapFilters {
  /** Keep only entities of these kinds. */
  readonly kinds?: readonly string[]
  /** Keep only entities with visible evidence from one of these sources. */
  readonly sources?: readonly string[]
  /** Keep only entities with visible evidence at or after this instant. */
  readonly since?: Date
}

/** A piece of evidence shown in the drawer — a signal the caller may see. */
export interface BrainMapEvidence {
  readonly signalId: string
  readonly source: string
  readonly url: string | null
  readonly excerpt: string
}

/** An artefact the entity links to, for the drawer to resolve. */
export interface BrainMapRelatedArtefact {
  readonly type: string
  readonly id: string
  readonly relation: string
}

/**
 * The entity drawer (AC4). For a brain entity, its compiled `page`; for an
 * external-authority entity, the source it is `authoritativeIn` and its
 * `externalUri`, and no page (BRAIN-11 AC7). Plus the evidence behind it and
 * the artefacts it links to, each resolving.
 */
export interface BrainMapEntityDetail {
  readonly id: string
  readonly kind: string
  readonly name: string
  readonly authority: 'brain' | 'external'
  readonly externalUri: string | null
  readonly page: string | null
  readonly authoritativeIn: string | null
  readonly evidence: readonly BrainMapEvidence[]
  readonly relatedArtefacts: readonly BrainMapRelatedArtefact[]
}

export interface BrainMap {
  read(input: {
    readonly workspaceId: string
    readonly userId: string
    readonly viewerScopeIds?: readonly string[]
    readonly filters?: BrainMapFilters
  }): Promise<BrainMapView>
  /**
   * One entity's drawer, or null when the caller may not see it — composed into
   * a not-found by the route, so an entity whose evidence the caller cannot see
   * reads exactly like one that does not exist (AC6).
   */
  drawer(input: {
    readonly workspaceId: string
    readonly userId: string
    readonly viewerScopeIds?: readonly string[]
    readonly entityId: string
  }): Promise<BrainMapEntityDetail | null>
}

/** How much of a signal's prose the drawer carries. The signal itself is a click away. */
const EVIDENCE_EXCERPT_CHARS = 500

/** A signal visible to the caller — public, or scoped to a group they are in. `$1` scopes. */
const SIGNAL_VISIBLE = `(s.permissions->>'visibility' = 'public' OR s.permissions->'scopeIds' ?| $1::text[])`

/**
 * A piece of evidence that counts: its signal is visible to the caller (public,
 * or scoped to a group the caller is in) and passes the source and time
 * filters. One fragment, reused in the EXISTS, the count and the max, so all
 * three agree — `$1` scopes, `$3` sources (or null), `$4` since (or null).
 */
const EVIDENCE_COUNTS = `(s.permissions->>'visibility' = 'public' OR s.permissions->'scopeIds' ?| $1::text[])
      AND ($3::text[] IS NULL OR s.source = ANY($3))
      AND ($4::timestamptz IS NULL OR s.occurred_at >= $4)`

/**
 * Nodes the caller may see, after filters: an entity of a kept kind (`$2`, or
 * null for all) with at least one piece of evidence that counts. Carries the
 * counting-evidence count and newest counting-evidence time; edge degree is
 * added to the salience in TS, over the visible edge set, so neither number
 * counts a source the caller cannot see or a filter excluded.
 */
const NODES_SQL = `SELECT e.id, e.kind, e.name, e.authority, e.external_uri, e.last_synced_at,
       (SELECT count(*) FROM entity_evidence v JOIN signals s ON s.id = v.signal_id
         WHERE v.entity_id = e.id AND ${EVIDENCE_COUNTS}) AS visible_evidence,
       (SELECT max(s.occurred_at) FROM entity_evidence v JOIN signals s ON s.id = v.signal_id
         WHERE v.entity_id = e.id AND ${EVIDENCE_COUNTS}) AS last_activity_at
   FROM entities e
  WHERE ($2::text[] IS NULL OR e.kind = ANY($2))
    AND EXISTS (
      SELECT 1 FROM entity_evidence v JOIN signals s ON s.id = v.signal_id
       WHERE v.entity_id = e.id AND ${EVIDENCE_COUNTS}
    )
  ORDER BY e.created_at`

/** Edges between two visible nodes. `$1` the visible node ids. */
const EDGES_SQL = `SELECT from_entity_id AS from_id, to_entity_id AS to_id, kind AS relation, confidence
   FROM entity_edges
  WHERE from_entity_id = ANY($1) AND to_entity_id = ANY($1)
  ORDER BY created_at`

interface NodeRow {
  id: string
  kind: string
  name: string
  authority: string
  external_uri: string | null
  visible_evidence: string | number
  last_activity_at: Date | null
  last_synced_at: Date | null
}

interface EdgeRow {
  from_id: string
  to_id: string
  relation: string
  confidence: number
}

export function createBrainMap(config: DbConfig, options: BrainMapOptions = {}): BrainMap {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>): Promise<T> =>
    withTenant(workspaceId, fn, { config })
  const now = options.now ?? (() => new Date())
  const staleAfterDays = options.staleAfterDays ?? STALE_AFTER_DAYS

  return {
    async read({ workspaceId, userId, viewerScopeIds, filters }) {
      // Empty or absent → null, so the query's `IS NULL` branch keeps all.
      const kinds = filters?.kinds && filters.kinds.length > 0 ? [...filters.kinds] : null
      const sources = filters?.sources && filters.sources.length > 0 ? [...filters.sources] : null
      const since = filters?.since ?? null
      return tx(workspaceId, async (t) => {
        // The scopes the caller holds (NFR-4), so the map shows a group exactly what retrieval would.
        const scopes = await resolveViewerScopes(t, userId, viewerScopeIds)
        const nodeRows = await t.query<NodeRow>(NODES_SQL, [scopes, kinds, sources, since])
        const ids = nodeRows.map((r) => r.id)
        const edgeRows = ids.length > 0 ? await t.query<EdgeRow>(EDGES_SQL, [ids]) : []

        // Degree over the visible edge set only, so salience never counts an
        // edge to a node the caller cannot see.
        const degree = new Map<string, number>()
        for (const e of edgeRows) {
          degree.set(e.from_id, (degree.get(e.from_id) ?? 0) + 1)
          degree.set(e.to_id, (degree.get(e.to_id) ?? 0) + 1)
        }

        // One instant for the whole map, so two nodes of the same age can never
        // straddle the threshold because the clock moved between them.
        const at = now()
        const nodes: BrainMapNode[] = nodeRows.map((r) => {
          const authority = r.authority === 'external' ? 'external' : 'brain'
          return {
            id: r.id,
            kind: r.kind,
            name: r.name,
            salience: Number(r.visible_evidence) + (degree.get(r.id) ?? 0),
            lastActivityAt: r.last_activity_at ? r.last_activity_at.toISOString() : null,
            freshness: classifyFreshness(
              { authority, lastActivityAt: r.last_activity_at, lastSyncedAt: r.last_synced_at },
              at,
              staleAfterDays,
            ),
            authority,
            externalUri: r.external_uri,
          }
        })
        const edges: BrainMapEdge[] = edgeRows.map((e) => ({
          from: e.from_id,
          to: e.to_id,
          relation: e.relation,
          confidence: e.confidence,
        }))
        return {
          nodes,
          edges,
          freshness: { staleAfterDays, definition: freshnessDefinition(staleAfterDays) },
        }
      })
    },

    async drawer({ workspaceId, userId, viewerScopeIds, entityId }) {
      return tx(workspaceId, async (t) => {
        const scopes = await resolveViewerScopes(t, userId, viewerScopeIds)
        // Visible iff it has at least one piece of evidence the caller may see;
        // otherwise null, and the route composes a not-found (AC6).
        const [ent] = await t.query<{
          id: string
          kind: string
          name: string
          authority: string
          external_uri: string | null
        }>(
          `SELECT e.id, e.kind, e.name, e.authority, e.external_uri
             FROM entities e
            WHERE e.id = $2
              AND EXISTS (SELECT 1 FROM entity_evidence v JOIN signals s ON s.id = v.signal_id
                           WHERE v.entity_id = e.id AND ${SIGNAL_VISIBLE})`,
          [scopes, entityId],
        )
        if (!ent) return null

        const evidenceRows = await t.query<{ id: string; source: string; url: string | null; text: string | null }>(
          `SELECT s.id, s.source, s.url, s.text
             FROM entity_evidence v JOIN signals s ON s.id = v.signal_id
            WHERE v.entity_id = $2 AND ${SIGNAL_VISIBLE}
            ORDER BY s.occurred_at DESC, s.id`,
          [scopes, entityId],
        )
        const related = await t.query<{ type: string; id: string; relation: string }>(
          `SELECT CASE WHEN from_type = 'entity' AND from_id = $1 THEN to_type ELSE from_type END AS type,
                  CASE WHEN from_type = 'entity' AND from_id = $1 THEN to_id ELSE from_id END AS id,
                  relation
             FROM artefact_links
            WHERE ((from_type = 'entity' AND from_id = $1) OR (to_type = 'entity' AND to_id = $1))
              AND state <> 'dangling'
            ORDER BY created_at`,
          [entityId],
        )
        const external = ent.authority === 'external'
        const page = external
          ? null
          : ((await t.query<{ markdown: string }>(`SELECT markdown FROM wiki_pages WHERE entity_id = $1`, [entityId]))[0]
              ?.markdown ?? null)

        return {
          id: ent.id,
          kind: ent.kind,
          name: ent.name,
          authority: external ? 'external' : 'brain',
          externalUri: ent.external_uri,
          page,
          // The source the external entity is authoritative in — the newest
          // visible evidence's source names the owning system.
          authoritativeIn: external ? (evidenceRows[0]?.source ?? null) : null,
          evidence: evidenceRows.map((e) => ({
            signalId: e.id,
            source: e.source,
            url: e.url,
            excerpt: (e.text ?? '').slice(0, EVIDENCE_EXCERPT_CHARS),
          })),
          relatedArtefacts: related.map((r) => ({ type: r.type, id: r.id, relation: r.relation })),
        }
      })
    },
  }
}
