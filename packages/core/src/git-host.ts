/**
 * Writing to a git host (CODE-5).
 *
 * Declared in `core` for the reason `ArtefactWriter` and `Sandbox` are: the
 * coding package writes through it and `packages/testing` fakes it, and a
 * contract owned by either would make the two depend on each other
 * (CLAUDE.md §10).
 *
 * Deliberately narrow, and read-free. The connectors already *read* pull
 * requests as signals; this is the small set of writes a coding job makes, and
 * keeping it separate means a compromised adapter cannot reach the read surface
 * through the same object.
 */

export interface GitHostBranch {
  readonly name: string
  /** The commit the branch was cut from. */
  readonly baseSha: string
}

export interface GitHostCommit {
  readonly sha: string
  readonly message: string
}

export interface GitHostPullRequest {
  readonly number: number
  readonly url: string
  readonly branch: string
}

export interface OpenPullRequest {
  readonly repositoryFullName: string
  readonly branch: string
  readonly baseBranch: string
  readonly title: string
  readonly body: string
  /**
   * A key unique to this job, so a retried collection does not open a second
   * pull request (CODE-5 AC5). The host is asked to be idempotent on it rather
   * than the caller checking first, because check-then-create loses the race
   * it exists to prevent.
   */
  readonly idempotencyKey: string
}

/**
 * The host refused to open the pull request.
 *
 * A distinct error rather than a generic one, carrying whether retrying could
 * possibly help: a protected branch will refuse forever and a rate limit will
 * not, and a job that offers "retry" for the first wastes somebody's time
 * twice (CODE-5 AC6).
 */
export class PullRequestRefusedError extends Error {
  override readonly name = 'PullRequestRefusedError'
  readonly retryable: boolean
  readonly detail: Record<string, unknown>

  constructor(message: string, retryable: boolean, detail: Record<string, unknown> = {}) {
    super(message)
    this.retryable = retryable
    this.detail = detail
  }
}

export interface GitHost {
  /** Cuts `branch` from `baseBranch`, or returns the existing one (AC1). */
  createBranch(
    repositoryFullName: string,
    branch: string,
    baseBranch: string,
  ): Promise<GitHostBranch>

  /**
   * Commits the working tree.
   *
   * `coAuthors` is how the requesting human appears in history beside the bot
   * (AC2). Attribution that named only the bot would make the log dishonest
   * about who asked; naming only the human would make it dishonest about who
   * wrote.
   */
  commit(options: {
    readonly repositoryFullName: string
    readonly branch: string
    readonly message: string
    readonly diff: string
    readonly authorName: string
    readonly authorEmail: string
    readonly coAuthors: readonly string[]
  }): Promise<GitHostCommit>

  openPullRequest(request: OpenPullRequest): Promise<GitHostPullRequest>
}
