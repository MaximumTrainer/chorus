import { createHash } from 'node:crypto'
import { ulid } from '@chorus/core'
import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'
import type { ModelProvider, ModelRef } from '@chorus/llm'
import type { ArtefactFragment, CodeFragment, Fragment, Retriever } from '@chorus/core'
import { DEFAULT_RETRIEVAL_KINDS } from '@chorus/core'
import { RRF_K, fuse, type FusedItem } from './fusion.js'

export interface RetrieverOptions {
  readonly models: ModelProvider
  readonly embeddingModel: ModelRef
  /**
   * Candidates each search contributes before fusion.
   *
   * Deliberately modest. Fusion rewards agreement, and past roughly the RRF
   * constant every rank contributes about the same — so a very long candidate
   * list stops discriminating and starts letting two deep appearances outrank
   * one confident hit. Keeping the lists short is the mitigation.
   *
   * Lives here rather than in the contract: it is a property of *this*
   * implementation, and a second one would tune something else entirely.
   */
  readonly candidatesPerSearch?: number
}

export { fuse, RRF_K } from './fusion.js'
export type { FusedItem, RankedItem } from './fusion.js'
export { RETRIEVABLE_KINDS } from '@chorus/core'
export type {
  ArtefactFragment,
  CodeFragment,
  ContextBundle,
  Fragment,
  RetrievableKind,
  RetrieveQuery,
  Retriever,
} from '@chorus/core'

/**
 * Retrieval (BRAIN-4, architecture.md §10.5).
 *
 * > Retrieval is the single point where grounding quality and privacy are both
 * > decided. Having exactly one implementation is what makes it possible to
 * > assert, once, that no path leaks content a user cannot see.
 *
 * That sentence is the reason this is a package rather than a helper next to
 * whichever caller needed it first. Chat, MCP, global search and every workflow
 * come through here, so the permission predicate is written once and asserted
 * once.
 *
 * **The predicate is part of the SQL.** Not a filter over results: a
 * post-filter silently reduces counts, and worse, leaks through them — a caller
 * asking for ten and receiving four has learned that six exist. Here the
 * forbidden rows are never candidates, so `considered` counts only what the
 * caller was allowed to see.
 */

const DEFAULT_K = 10
const DEFAULT_CANDIDATES = 50

interface ChunkRow {
  id: string
  repository_id: string
  path: string
  text: string
  line_start: number
  line_end: number
  symbol_name: string | null
}

/**
 * The permission predicate.
 *
 * A chunk is visible when its file's repository belongs to a team the caller is
 * a member of — resolved to a list of repository ids, then applied inside the
 * ranking query as `repository_id = ANY(...)`.
 *
 * The obvious spelling is a correlated `EXISTS` on each chunk, and it is a
 * trap. The planner finds that subquery highly selective, drives the whole
 * query from *files*, and then scans every chunk in each one — the full-text
 * index is never used, and latency grows linearly with the corpus. Measured:
 * 4.16× slower for a 4× corpus, with `Rows Removed by Filter: 498` per file.
 *
 * Resolving the ids first is still filtering *in the query*, which is what AC2
 * requires: forbidden rows are never candidates, so counts and scores cannot
 * leak what was hidden. What changes is only which index the planner can reach
 * for. The list is bounded by how many repositories a person's teams have,
 * which is small.
 */
/**
 * The lexical query for a question (#160).
 *
 * `plainto_tsquery` ANDs every term, which is right for a search box and wrong
 * for the questions this system asks. A task is called "Fix parseInvoice so it
 * balances", and requiring the code to contain "fix", "so", "it" and "balances"
 * reduces a precise query to no match at all — the caller sees an empty result
 * rather than a weak one, which is indistinguishable from "nothing is relevant".
 *
 * So terms are ORed and `ts_rank` decides: a chunk matching three of them
 * outranks one matching a single term, which is the behaviour the ranking was
 * always there to provide. What stops this returning everything is unchanged —
 * the distance ceiling on the vector half, and the confidence floor above it.
 *
 * Tokens are reduced to `[a-z0-9_]` here, so the string handed to `to_tsquery`
 * can carry no operators of its own.
 */
export function anyTermQuery(question: string): string {
  const terms = question
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((term) => term.length > 1)
  // A question of nothing but punctuation and single letters matches nothing,
  // which is the honest answer. An empty string would make `to_tsquery` throw
  // and turn a degenerate query into a failed request.
  const unique = [...new Set(terms)]
  return unique.length > 0 ? unique.join(' | ') : '__no_matching_terms__'
}

/**
 * The lexical half: two indexed searches unioned, rather than one query with an
 * `OR`.
 *
 * The `OR` spelling is the obvious one and it is a trap: a runtime
 * `ILIKE '%' || $1 || '%'` cannot become an index condition, so the planner
 * gives up on the GIN index for *both* halves and scans the table. Measured at
 * 20k chunks: 32ms with the OR, 3.7ms with the full-text half alone. A UNION
 * lets each half reach its own index — `code_chunks_search` for the text,
 * `code_chunks_symbol_trgm` for the identifier substring — and the fusion
 * downstream does not care that they arrived separately.
 *
 * `$1` question, `$2` repository ids, `$3` candidate limit, `$4` tsquery.
 *
 * Exported because `test/integration/query-plans.test.ts` asserts the plan of
 * *this* string. The assertion used to be written against a copy, and a copy is
 * how the vector half below came to scan the table for a fortnight while a test
 * reported the index being used (#155).
 */
export const LEXICAL_SEARCH_SQL = `SELECT matched.id, matched.repository_id, f.path, matched.text,
       matched.line_start, matched.line_end, matched.symbol_name
   FROM (
     (SELECT c.id, c.repository_id, c.file_id, c.text, c.line_start, c.line_end,
             c.symbol_name,
             ts_rank(c.search, to_tsquery('simple', $4)) AS rank
        FROM code_chunks c
       WHERE c.repository_id = ANY($2)
         AND c.search @@ to_tsquery('simple', $4)
       ORDER BY rank DESC, c.id
       LIMIT $3)
     UNION
     (SELECT c.id, c.repository_id, c.file_id, c.text, c.line_start, c.line_end,
             c.symbol_name,
             -- Below any real ts_rank, so a substring match ranks after a
             -- genuine text match rather than beside it.
             0.0001 AS rank
        FROM code_chunks c
       WHERE c.repository_id = ANY($2)
         AND c.symbol_name ILIKE '%' || $1 || '%'
       ORDER BY c.id
       LIMIT $3)
   ) matched
   JOIN code_files f ON f.id = matched.file_id
  ORDER BY matched.rank DESC, matched.id
  LIMIT $3`

/**
 * The vector half.
 *
 * Two structural rules, and both were learned by measuring:
 *
 * **The distance ceiling is applied outside the ranked subquery.** pgvector
 * uses the HNSW index for `ORDER BY <=> LIMIT`; a predicate on the distance is
 * not indexable, so putting the ceiling in the inner WHERE forces the distance
 * to be computed for every row in the table. The first version did exactly that
 * and grew super-linearly — 642ms at 20k chunks, against a 300ms budget for a
 * corpus fifty times larger.
 *
 * **The join to `code_files` is also outside it** (#155). With the join inside,
 * the planner drives the query from *files* and nested-loops into
 * `code_chunks_by_file`, computing the distance for every chunk of every file
 * and top-N sorting the lot — the HNSW index is never opened. Measured at 20k
 * chunks: 121ms with the join inside, 2.5ms with it outside, and the gap widens
 * with the corpus because the inner plan is linear in it. The path is needed
 * for the citation, but it is needed for fifty rows, not for twenty thousand:
 * resolving it after the LIMIT costs one index lookup per returned row.
 *
 * `$1` query vector, `$2` repository ids, `$3` candidate limit, `$4` ceiling.
 */
export const VECTOR_SEARCH_SQL = `SELECT ranked.id, ranked.repository_id, f.path, ranked.text,
       ranked.line_start, ranked.line_end, ranked.symbol_name
   FROM (
     SELECT c.id, c.repository_id, c.file_id, c.text, c.line_start, c.line_end,
            c.symbol_name, (c.embedding <=> $1::vector) AS distance
       FROM code_chunks c
      WHERE c.repository_id = ANY($2)
        AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> $1::vector
      LIMIT $3
   ) ranked
   JOIN code_files f ON f.id = ranked.file_id
  -- AC6: everything is nearest to something, so without a ceiling every query
  -- returns its k nearest chunks whatever the corpus holds.
  WHERE ranked.distance < $4
  ORDER BY ranked.distance, ranked.id`

/**
 * The lexical half over tasks and documents (BRAIN-4, widened in Phase 1).
 *
 * One query over both, ranked together, so a task and a document are ordered
 * by how well they match rather than by which table was asked first. The
 * permission predicate is the product's own for these artefacts: row-level
 * security to the workspace, and nothing deleted. A workspace member can read
 * any team's tasks and documents in the product, so retrieval may too.
 * Anything stricter here would make search disagree with the screens it links
 * to (MCP-5 AC2).
 *
 * There is no vector half for artefacts yet. Nothing embeds a task or a
 * document on write, and a vector search over empty embeddings would return
 * nothing while looking like it had been asked. An artefact therefore arrives
 * through one search, and its confidence says so.
 *
 * `$1` tsquery, `$2` kinds, `$3` candidate limit.
 */
export const ARTEFACT_SEARCH_SQL = `SELECT matched.kind, matched.id, matched.team_id, matched.title,
       matched.key, matched.body
   FROM (
     (SELECT 'task' AS kind, t.id, t.team_id, t.title, t.key,
             t.title || E'\n\n' ||
               coalesce((SELECT string_agg(value #>> '{}', E'\n')
                           FROM jsonb_array_elements(
                             jsonb_path_query_array(t.acceptance_criteria, 'strict $.**.text'))),
                        '') AS body,
             ts_rank(t.search, to_tsquery('simple', $1)) AS rank
        FROM tasks t
       WHERE 'task' = ANY($2) AND t.deleted_at IS NULL
         AND t.search @@ to_tsquery('simple', $1)
       ORDER BY rank DESC, t.id
       LIMIT $3)
     UNION ALL
     (SELECT 'document' AS kind, d.id, d.team_id, d.title, NULL AS key,
             d.body_md_cache AS body,
             ts_rank(d.search, to_tsquery('simple', $1)) AS rank
        FROM documents d
       WHERE 'document' = ANY($2) AND d.deleted_at IS NULL
         AND d.search @@ to_tsquery('simple', $1)
       ORDER BY rank DESC, d.id
       LIMIT $3)
   ) matched
  ORDER BY matched.rank DESC, matched.id
  LIMIT $3`

interface ArtefactRow {
  kind: 'task' | 'document'
  id: string
  team_id: string
  title: string
  key: string | null
  body: string
}

/** How much of an artefact's text a fragment carries. A fragment is evidence, not the document. */
const ARTEFACT_EXCERPT_CHARS = 2000

async function visibleRepositories(t: TenantTx, userId: string): Promise<string[]> {
  const rows = await t.query<{ id: string }>(
    `SELECT r.id
       FROM repositories r
       JOIN team_members tm ON tm.team_id = r.team_id AND tm.deleted_at IS NULL
      WHERE tm.user_id = $1 AND r.deleted_at IS NULL`,
    [userId],
  )
  return rows.map((row) => row.id)
}

/** The order fusion itself uses, so merging two fused lists cannot reorder either. */
function compareFused<T extends { id: string }>(a: FusedItem<T>, b: FusedItem<T>): number {
  if (b.score !== a.score) return b.score - a.score
  if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length
  return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0
}

export function createRetriever(config: DbConfig, options: RetrieverOptions): Retriever {
  const candidates = options.candidatesPerSearch ?? DEFAULT_CANDIDATES

  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>): Promise<T> =>
    withTenant(workspaceId, fn, { config })

  /**
   * A citation id, derived from the fragment it points at.
   *
   * Includes the line range and the text hash, so a chunk whose content changed
   * gets a different id — a citation that silently kept pointing at a rewritten
   * file would be worse than one that visibly stopped resolving.
   */
  const citationOf = (row: ChunkRow): string =>
    createHash('sha256')
      .update(`${row.repository_id} ${row.path} ${row.line_start}-${row.line_end} `)
      .update(row.text)
      .digest('hex')
      .slice(0, 16)

  return {
    async retrieve(query) {
      const k = query.k ?? DEFAULT_K
      const kinds = query.kinds ?? DEFAULT_RETRIEVAL_KINDS
      const artefactKinds = kinds.filter((kind) => kind === 'task' || kind === 'document')

      const repoFilter = query.filters?.repoIds?.length ? query.filters.repoIds : null

      // Artefacts. Asked for only when wanted, so a code-only caller pays for
      // nothing it does not read.
      const artefacts =
        artefactKinds.length > 0
          ? await tx(query.workspaceId, (t) =>
              t.query<ArtefactRow>(ARTEFACT_SEARCH_SQL, [
                anyTermQuery(query.query),
                artefactKinds,
                candidates,
              ]),
            )
          : []

      const [lexical, vector] = !kinds.includes('code')
        ? ([[], []] as const)
        : await tx(query.workspaceId, async (t) => {
        const permitted = await visibleRepositories(t, query.userId)
        // A caller in no team sees nothing, and asks the database nothing. An
        // empty list left in an `= ANY(...)` is correct but still a query; more
        // importantly, an empty list must never be allowed to become an
        // *unconstrained* one, which is the classic post-filter failure.
        const repos = repoFilter
          ? permitted.filter((id) => repoFilter.includes(id))
          : permitted
        if (repos.length === 0) return [[], []] as const

        // Both searches run against the same list and the same filters, so
        // neither half can see something the other cannot.
        const lexicalRows = await t.query<ChunkRow>(LEXICAL_SEARCH_SQL, [
          query.query,
          repos,
          candidates,
          anyTermQuery(query.query),
        ])

        const embedding = await embed(query.query)
        const vectorRows = embedding
          ? await t.query<ChunkRow>(VECTOR_SEARCH_SQL, [
              `[${embedding.join(',')}]`,
              repos,
              candidates,
              MAX_COSINE_DISTANCE,
            ])
          : []

        return [lexicalRows, vectorRows] as const
      })

      const byId = new Map<string, ChunkRow>()
      for (const row of [...lexical, ...vector]) byId.set(row.id, row)
      const artefactById = new Map(artefacts.map((row) => [`${row.kind}:${row.id}`, row]))

      // Code is fused across its two searches. Artefacts come from one, ranked
      // on their own. Both are on the same reciprocal-rank scale, so they are
      // merged by score and cut to k together, with agreement between
      // searches still breaking ties first.
      const codeFused = fuse(
        { lexical: lexical.map((r) => ({ id: r.id })), vector: vector.map((r) => ({ id: r.id })) },
        { limit: k },
      )
      const artefactFused = fuse(
        { lexical: artefacts.map((r) => ({ id: `${r.kind}:${r.id}` })) },
        { limit: k },
      )
      const ranked = [
        ...codeFused.map((entry) => ({ entry, kind: 'code' as const })),
        ...artefactFused.map((entry) => ({ entry, kind: 'artefact' as const })),
      ]
        .sort((a, b) => compareFused(a.entry, b.entry))
        .slice(0, k)

      // First place in both searches. Normalising against it is what turns a
      // reciprocal-rank score into a number a caller can put a threshold on.
      const bestPossible = 2 / (RRF_K + 1)

      const fragments = ranked.map(({ entry, kind }): Fragment => {
        const confidence = Math.min(1, entry.score / bestPossible)
        if (kind === 'artefact') {
          const row = artefactById.get(entry.item.id)!
          const text = row.body.slice(0, ARTEFACT_EXCERPT_CHARS)
          const fragment: ArtefactFragment = {
            citationId: createHash('sha256')
              .update(`${row.kind} ${row.id} `)
              .update(text)
              .digest('hex')
              .slice(0, 16),
            kind: row.kind,
            artefactId: row.id,
            teamId: row.team_id,
            title: row.title,
            key: row.key,
            text,
            score: entry.score,
            confidence,
            sources: entry.sources,
          }
          return fragment
        }
        const row = byId.get(entry.item.id)!
        const fragment: CodeFragment = {
          citationId: citationOf(row),
          kind: 'code',
          chunkId: row.id,
          repositoryId: row.repository_id,
          path: row.path,
          lineStart: row.line_start,
          lineEnd: row.line_end,
          symbolName: row.symbol_name,
          text: row.text,
          score: entry.score,
          confidence,
          sources: entry.sources,
        }
        return fragment
      })

      return {
        id: ulid(),
        query: query.query,
        userId: query.userId,
        teamId: query.teamId,
        fragments,
        considered: byId.size + artefactById.size,
      }
    },

    async persist(workspaceId, bundle) {
      await tx(workspaceId, (t) =>
        t.execute(
          `INSERT INTO context_bundles
             (id, workspace_id, user_id, team_id, query, parameters, fragments, considered)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
           ON CONFLICT (id) DO NOTHING`,
          [
            bundle.id,
            workspaceId,
            bundle.userId,
            bundle.teamId,
            bundle.query,
            JSON.stringify({ k: bundle.fragments.length }),
            // References, not copies: what is stored resolves the fragments
            // again rather than duplicating them, so a re-indexed chunk shows
            // as a citation that no longer resolves instead of one that
            // silently drifted from its source.
            JSON.stringify(bundle.fragments),
            bundle.considered,
          ],
        ),
      )
    },

    async load(workspaceId, bundleId) {
      const [row] = await tx(workspaceId, (t) =>
        t.query<{
          id: string
          query: string
          user_id: string
          team_id: string | null
          fragments: Fragment[]
          considered: number
        }>(
          `SELECT id, query, user_id, team_id, fragments, considered
             FROM context_bundles WHERE id = $1`,
          [bundleId],
        ),
      )
      if (!row) return undefined
      return {
        id: row.id,
        query: row.query,
        userId: row.user_id,
        teamId: row.team_id ?? '',
        fragments: row.fragments,
        considered: row.considered,
      }
    },
  }

  async function embed(text: string): Promise<number[] | undefined> {
    const [vector] = await options.models.embed([text], options.embeddingModel)
    return vector
  }
}

/**
 * How far a vector match may be and still count.
 *
 * Cosine distance, so 0 is identical and 2 is opposite. Without a ceiling every
 * query returns its k nearest chunks whatever the corpus contains — everything
 * is nearest to something — and AC6's "no low-relevance filler to appear
 * helpful" becomes impossible. 0.6 is the point at which the fake provider's
 * word-overlap embeddings stop sharing meaningful vocabulary; it belongs in the
 * evaluation set's remit, not in intuition.
 */
const MAX_COSINE_DISTANCE = 0.6
