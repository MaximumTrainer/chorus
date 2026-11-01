import { LimitExceededError, type GitHost } from '@chorus/core'
import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Committing the compiled wiki to git (BRAIN-5).
 *
 * The compiler leaves pages in `wiki_pages`; this commits the ones that have
 * changed to the configured repository under a bot identity. Only changed
 * pages go into the commit, so a single edit is a single small commit rather
 * than whole-repository churn (AC3). The commit is authored by the bot with a
 * message naming what changed (AC6). A failed push retries with backoff and
 * leaves nothing half-committed — the published marker moves only after the
 * commit succeeds, so a crash mid-run re-commits rather than losing work (AC5).
 */

export interface WikiPublishResult {
  readonly state: 'committed' | 'nothing_to_commit' | 'failed'
  readonly committed: number
  readonly sha?: string
  readonly reason?: string
}

export interface WikiPublisher {
  publish(workspaceId: string): Promise<WikiPublishResult>
}

interface PageRow {
  readonly id: string
  readonly kind: string
  readonly slug: string
  readonly markdown: string
  readonly content_hash: string
}

export interface WikiPublisherDeps {
  readonly config: DbConfig
  readonly gitHost: GitHost
  readonly repositoryFullName: string
  readonly baseBranch?: string
  readonly bot: { readonly name: string; readonly email: string }
  /** Attempts before giving up on a retryable failure. */
  readonly maxAttempts?: number
  /** Backoff between attempts; a no-op in tests. */
  readonly backoff?: (attempt: number) => Promise<void>
}

export function createWikiPublisher(deps: WikiPublisherDeps): WikiPublisher {
  const branch = deps.baseBranch ?? 'main'
  const maxAttempts = deps.maxAttempts ?? 4
  const backoff = deps.backoff ?? (async () => {})
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>) =>
    withTenant(workspaceId, fn, { config: deps.config })

  return {
    async publish(workspaceId) {
      // Only pages whose committed hash has moved — the incremental set.
      const changed = await tx(workspaceId, (t) =>
        t.query<PageRow>(
          `SELECT id, kind, slug, markdown, content_hash
             FROM wiki_pages
            WHERE published_hash IS DISTINCT FROM content_hash
            ORDER BY kind, slug`,
        ),
      )
      if (changed.length === 0) return { state: 'nothing_to_commit', committed: 0 }

      // One commit for the whole changed set — atomic, so a failure leaves no
      // partial state. The diff is the pages at their paths; the message names
      // what moved so the log is honest about why.
      const diff = changed
        .map((p) => `# wiki/${p.kind}/${p.slug}.md\n${p.markdown}`)
        .join('\n\n')
      const message =
        changed.length === 1
          ? `Compile wiki: ${changed[0]!.kind}/${changed[0]!.slug}`
          : `Compile wiki: ${changed.length} pages (${changed
              .slice(0, 3)
              .map((p) => `${p.kind}/${p.slug}`)
              .join(', ')}${changed.length > 3 ? ', …' : ''})`

      let lastError: unknown
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const commit = await deps.gitHost.commit({
            repositoryFullName: deps.repositoryFullName,
            branch,
            message,
            diff,
            authorName: deps.bot.name,
            authorEmail: deps.bot.email,
            coAuthors: [],
          })
          // Only now, after the commit landed, mark the pages published — so a
          // failure before this re-commits them rather than dropping them.
          await tx(workspaceId, async (t) => {
            for (const page of changed) {
              await t.execute(`UPDATE wiki_pages SET published_hash = $2 WHERE id = $1`, [
                page.id,
                page.content_hash,
              ])
            }
          })
          return { state: 'committed', committed: changed.length, sha: commit.sha }
        } catch (error) {
          lastError = error
          // A quota is not a transient fault — stop and surface it. Anything
          // else (auth blip, conflict, unavailable remote) is worth a backoff.
          const retryable = !(error instanceof LimitExceededError)
          if (!retryable || attempt === maxAttempts) break
          await backoff(attempt)
        }
      }
      return {
        state: 'failed',
        committed: 0,
        reason: lastError instanceof Error ? lastError.message : String(lastError),
      }
    },
  }
}
