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

export const RETRIEVABLE_KINDS = ['code'] as const
export type RetrievableKind = (typeof RETRIEVABLE_KINDS)[number]

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

export interface Fragment {
  /**
   * Stable across retrievals of the same fragment.
   *
   * Derived from what is cited rather than from when it was cited: an id that
   * changed per retrieval would make two bundles of the same fragment
   * impossible to compare, which is what the evaluation harness does (AC4).
   */
  readonly citationId: string
  readonly kind: RetrievableKind
  readonly chunkId: string
  readonly repositoryId: string
  readonly path: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly symbolName: string | null
  readonly text: string
  readonly score: number
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

