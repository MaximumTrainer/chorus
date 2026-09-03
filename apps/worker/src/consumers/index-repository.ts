import { NotFoundError } from '@chorus/core'
import { withTenant, type DbConfig } from '@chorus/db'
import type { Indexer } from '@chorus/indexer'
import type { Job } from '@chorus/queue'
import { withWorkingCopy } from '../checkout.js'

/**
 * Repository indexing, driven by the queue (BRAIN-2, INT-2 AC3).
 *
 * The consumer that closes the loop: a push webhook arrives at the API, the API
 * enqueues, this checks out the commit and re-indexes, and the working copy is
 * destroyed. Nothing here knows what a webhook is — it takes a repository and a
 * commit, so a scheduled sync, a push and a manual re-index are one code path.
 *
 * **Idempotency** (CLAUDE.md §6.7) comes from two places, and it needs both.
 * The queue collapses repeat *deliveries* by key. The indexer collapses repeat
 * *work* by content hash, so a job that genuinely runs twice re-parses nothing
 * and re-embeds nothing. Either alone would be insufficient: a key cannot
 * survive a queue flush, and a hash cannot stop two workers starting at once.
 */

export const INDEX_REPOSITORY_QUEUE = 'index.repository'

export interface IndexRepositoryJob {
  readonly workspaceId: string
  readonly repositoryId: string
  readonly commitSha: string
  /**
   * Paths a push reported as changed.
   *
   * Advisory only — the indexer decides what changed by content hash, which is
   * true whatever route the change arrived by. Carried so a future consumer can
   * skip the walk entirely for a one-file push, and recorded on the run either
   * way so "why did this re-index" is answerable.
   */
  readonly changedPaths?: readonly string[]
}

/**
 * How the worker reaches a repository's clone URL and a token for it.
 *
 * Injected rather than built here: minting a scoped token is the git
 * connector's job (INT-2 AC2), and a worker that knew how would be a second
 * place that has to get token scoping right.
 */
export interface RepositoryAccess {
  cloneUrlFor(input: {
    workspaceId: string
    repositoryId: string
    provider: string
    fullName: string
  }): Promise<{ remote: string; token?: string }>
}

export interface IndexRepositoryDeps {
  readonly dbConfig: DbConfig
  readonly indexer: Indexer
  readonly access: RepositoryAccess
}

export function indexRepositoryConsumer(deps: IndexRepositoryDeps) {
  return async (job: Job<IndexRepositoryJob>): Promise<void> => {
    const { workspaceId, repositoryId, commitSha } = job.payload

    const [repository] = await withTenant(
      workspaceId,
      (tx) =>
        tx.query<{ provider: string; full_name: string }>(
          `SELECT provider, full_name FROM repositories
            WHERE id = $1 AND deleted_at IS NULL`,
          [repositoryId],
        ),
      { config: deps.dbConfig },
    )

    // Unlinked between enqueue and consume. Not an error worth retrying: the
    // repository is gone, and three more attempts will find it just as gone.
    if (!repository) {
      throw new NotFoundError('No such repository', { repositoryId })
    }

    const { remote, token } = await deps.access.cloneUrlFor({
      workspaceId,
      repositoryId,
      provider: repository.provider,
      fullName: repository.full_name,
    })

    await withWorkingCopy({ remote, commitSha, ...(token ? { token } : {}) }, async (copy) => {
      await deps.indexer.index({
        workspaceId,
        repositoryId,
        workingCopy: copy.path,
        commitSha,
      })
    })
  }
}
