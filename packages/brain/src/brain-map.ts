import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'

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

export interface BrainMap {
  read(input: {
    readonly workspaceId: string
    readonly userId: string
    readonly viewerScopeIds?: readonly string[]
    readonly filters?: BrainMapFilters
  }): Promise<BrainMapView>
}

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
const NODES_SQL = `SELECT e.id, e.kind, e.name, e.authority, e.external_uri,
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
}

interface EdgeRow {
  from_id: string
  to_id: string
  relation: string
  confidence: number
}

export function createBrainMap(config: DbConfig): BrainMap {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>): Promise<T> =>
    withTenant(workspaceId, fn, { config })

  return {
    async read({ workspaceId, viewerScopeIds, filters }) {
      const scopes = viewerScopeIds ? [...viewerScopeIds] : []
      // Empty or absent → null, so the query's `IS NULL` branch keeps all.
      const kinds = filters?.kinds && filters.kinds.length > 0 ? [...filters.kinds] : null
      const sources = filters?.sources && filters.sources.length > 0 ? [...filters.sources] : null
      const since = filters?.since ?? null
      return tx(workspaceId, async (t) => {
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

        const nodes: BrainMapNode[] = nodeRows.map((r) => ({
          id: r.id,
          kind: r.kind,
          name: r.name,
          salience: Number(r.visible_evidence) + (degree.get(r.id) ?? 0),
          lastActivityAt: r.last_activity_at ? r.last_activity_at.toISOString() : null,
          authority: r.authority === 'external' ? 'external' : 'brain',
          externalUri: r.external_uri,
        }))
        const edges: BrainMapEdge[] = edgeRows.map((e) => ({
          from: e.from_id,
          to: e.to_id,
          relation: e.relation,
          confidence: e.confidence,
        }))
        return { nodes, edges }
      })
    },
  }
}
