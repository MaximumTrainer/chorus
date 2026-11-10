import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Mirroring the compiled wiki into an external space (INT-9 AC7).
 *
 * The git publisher commits the wiki to a repository; this is the same idea
 * aimed at a Confluence space, for a team whose canonical wiki is Confluence
 * rather than git. The compiler leaves pages in `wiki_pages`; the mirror
 * publishes each one to the space through an injected target, so the brain does
 * not import a connector — exactly as the git publisher takes a `GitHost`.
 *
 * Human-edit protection is the same rule as git's, not a second one: a page a
 * person hand-edited (its `human_edited_at` set) is never overwritten by the
 * mirror, and an edit made on the Confluence side is routed back through the
 * very same `reconcileHumanEdit` the git path uses — which marks the page and
 * raises a review item (AC7). So the mirror's own job is only the forward push
 * of the pages a person has not claimed.
 */

export interface WikiMirrorPage {
  readonly kind: string
  readonly slug: string
  readonly markdown: string
}

export interface WikiMirrorTarget {
  /** Publish (create or update) one wiki page in the mirror space. */
  publish(page: WikiMirrorPage): Promise<void>
}

export interface WikiMirrorResult {
  readonly state: 'mirrored' | 'nothing_to_mirror'
  /** Pages pushed to the space. */
  readonly mirrored: number
  /** Pages left untouched because a person hand-edited them. */
  readonly protectedPages: number
}

export interface WikiMirror {
  mirror(workspaceId: string): Promise<WikiMirrorResult>
}

interface PageRow {
  readonly kind: string
  readonly slug: string
  readonly markdown: string
  readonly human_edited_at: Date | null
}

export function createWikiMirror(deps: { config: DbConfig; target: WikiMirrorTarget }): WikiMirror {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>): Promise<T> =>
    withTenant(workspaceId, fn, { config: deps.config })

  return {
    async mirror(workspaceId) {
      const pages = await tx(workspaceId, (t) =>
        t.query<PageRow>(
          `SELECT kind, slug, markdown, human_edited_at FROM wiki_pages ORDER BY kind, slug`,
        ),
      )
      if (pages.length === 0) return { state: 'nothing_to_mirror', mirrored: 0, protectedPages: 0 }

      let mirrored = 0
      let protectedPages = 0
      for (const page of pages) {
        // A hand-edited page is protected exactly as it is against the compiler
        // and the git publisher: left as the person wrote it, never clobbered.
        if (page.human_edited_at) {
          protectedPages += 1
          continue
        }
        await deps.target.publish({ kind: page.kind, slug: page.slug, markdown: page.markdown })
        mirrored += 1
      }
      return mirrored === 0
        ? { state: 'nothing_to_mirror', mirrored: 0, protectedPages }
        : { state: 'mirrored', mirrored, protectedPages }
    },
  }
}
