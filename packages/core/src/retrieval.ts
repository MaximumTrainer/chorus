import { z } from 'zod'

/**
 * The retrieval contract (BRAIN-4, architecture.md §10.5).
 *
 * Declared in `core` rather than in `packages/brain` because a feature package
 * may only reach another through a `core` interface (architecture.md §7). The
 * agent runtime consumes a `Retriever`; the brain implements one; neither
 * imports the other. Putting the interface in the implementation created a
 * cycle the moment the runtime needed it — caught by the build, which is the
 * point of having the rule.
 */

export const RETRIEVABLE_KINDS = ['code', 'task', 'document'] as const
export type RetrievableKind = (typeof RETRIEVABLE_KINDS)[number]

/**
 * What a query searches when it names no kinds: code.
 *
 * Not every kind. The callers that existed before tasks and documents were
 * retrievable, an agent's retrieve step and code pointers, were written for
 * code fragments, and widening them silently would hand a pointer generator a
 * task to point at. A caller that wants artefacts asks for them, as search does.
 */
export const DEFAULT_RETRIEVAL_KINDS: readonly RetrievableKind[] = ['code']

export interface RetrieveQuery {
  readonly query: string
  readonly workspaceId: string
  readonly teamId: string
  readonly userId: string
  readonly kinds?: readonly RetrievableKind[]
  readonly k?: number
  /** Graph hops. Bounded because expansion is exponential in the hop count. */
  readonly expand?: 0 | 1 | 2
  readonly filters?: { readonly repoIds?: readonly string[] }
}

/** What every fragment carries, whatever it cites. */
interface FragmentBase {
  /**
   * Stable across retrievals of the same fragment.
   *
   * Derived from what is cited rather than from when it was cited: an id that
   * changed per retrieval would make two bundles of the same fragment
   * impossible to compare, which is what the evaluation harness does (AC4).
   */
  readonly citationId: string
  readonly text: string
  /**
   * The raw fusion score. Useful for ordering, meaningless on its own.
   */
  readonly score: number
  /**
   * The same result on a 0–1 scale, relative to the best a fragment could
   * possibly score (AC6, and TASK-3's confidence).
   *
   * A reciprocal-rank score is a *ranking* device: `1/(k+rank)` is about 0.016
   * at the top with the usual constant, which means nothing to a consumer and
   * cannot be compared against a threshold anybody would write down. Dividing
   * by the maximum attainable — first place in every search — turns it into
   * something a caller can reason about, and it keeps the property that
   * agreement between searches beats a single strong hit.
   */
  readonly confidence: number
  /** Which searches found it — `lexical`, `vector`, or both. */
  readonly sources: readonly string[]
  /**
   * Present when this arrived by graph expansion rather than by matching.
   *
   * AC3 requires expansion results to be *marked as expansion*. An expanded
   * fragment is context, not evidence, and a model told otherwise will cite it
   * as though the query had found it.
   */
  readonly viaExpansion?: { readonly fromChunkId: string; readonly reason: string }
}

/** A cited span of indexed code. */
export interface CodeFragment extends FragmentBase {
  readonly kind: 'code'
  readonly chunkId: string
  readonly repositoryId: string
  readonly path: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly symbolName: string | null
}

/**
 * A cited task or document.
 *
 * The text is the artefact's own words, a task's title and criteria or a
 * document's rendered body, cut to a bounded excerpt. The id is what a reader
 * opens, through the same routes and permissions as everywhere else.
 */
export interface ArtefactFragment extends FragmentBase {
  readonly kind: 'task' | 'document'
  readonly artefactId: string
  readonly teamId: string
  readonly title: string
  /** A task's key, such as CH-4. Null for a document. */
  readonly key: string | null
}

export type Fragment = CodeFragment | ArtefactFragment

export interface ContextBundle {
  readonly id: string
  readonly query: string
  /**
   * Who it was assembled for, and under which team.
   *
   * Carried rather than passed separately at persist time, because retrieval is
   * permission-filtered: a bundle is only meaningful alongside the identity it
   * was filtered against, and storing one without that would make it
   * impossible to say later what it was allowed to contain.
   */
  readonly userId: string
  readonly teamId: string
  readonly fragments: readonly Fragment[]
  /**
   * How many candidates the caller was permitted to see.
   *
   * Distinct from the number returned, so "there is more" is honest — and
   * counted after the permission predicate, so it never reveals what was
   * filtered out.
   */
  readonly considered: number
}

export interface Retriever {
  retrieve(query: RetrieveQuery): Promise<ContextBundle>
  persist(workspaceId: string, bundle: ContextBundle): Promise<void>
  load(workspaceId: string, bundleId: string): Promise<ContextBundle | undefined>
}


/**
 * A search over the API (BRAIN-4): what `POST …/teams/{teamId}/search` takes.
 *
 * `k` is capped well below what an agent's context could hold, because a
 * bundle is the front of a prompt and a long one crowds out the question.
 */
export const SearchRequestSchema = z
  .object({
    query: z.string().trim().min(1, 'query must not be empty').max(2000),
    k: z.number().int().min(1).max(50).optional(),
    repositoryIds: z.array(z.string().min(1)).max(50).optional(),
    kinds: z
      .array(z.enum(RETRIEVABLE_KINDS))
      .min(1)
      .optional()
      .describe('What to search: code, task, document. All of them by default.'),
  })
  .strict()
export type SearchRequest = z.infer<typeof SearchRequestSchema>
