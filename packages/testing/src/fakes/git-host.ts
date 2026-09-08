import {
  PullRequestRefusedError,
  type GitHost,
  type GitHostBranch,
  type GitHostCommit,
  type GitHostPullRequest,
  type OpenPullRequest,
} from '@chorus/core'

/**
 * A scriptable git host (CLAUDE.md §4, CODE-5).
 *
 * Never a real git host from a test — not only for the obvious reasons, but
 * because the cases that matter here are ones a real host will not produce on
 * request: a protected branch, a rate limit, a branch that already exists, a
 * collection step retried after a crash. Those are the paths where a coding job
 * either preserves somebody's work or loses it.
 *
 * It records everything, because most of what CODE-5 promises is about *what
 * was written* rather than what came back: the co-author trailer, the criteria
 * checklist, the links. A fake that returned a plausible URL and kept nothing
 * would let all of that rot silently.
 */

export interface FakeGitHostScript {
  /** The next `openPullRequest` fails this way. */
  readonly refusePullRequest?: { readonly message: string; readonly retryable: boolean }
  /** The branch already exists, as it does on a retried or re-run job. */
  readonly branchExists?: boolean
}

export interface FakeGitHost extends GitHost {
  script(next: FakeGitHostScript): void
  branches(): readonly GitHostBranch[]
  commits(): readonly (GitHostCommit & { readonly coAuthors: readonly string[] })[]
  pullRequests(): readonly (GitHostPullRequest & { readonly title: string; readonly body: string })[]
}

export function createFakeGitHost(initial: FakeGitHostScript = {}): FakeGitHost {
  let current: FakeGitHostScript = initial
  const branches: GitHostBranch[] = []
  const commits: (GitHostCommit & { coAuthors: readonly string[] })[] = []
  const pullRequests: (GitHostPullRequest & { title: string; body: string })[] = []
  /** Keyed by idempotency key, so a retry returns the first one (AC5). */
  const byKey = new Map<string, GitHostPullRequest>()

  let nextNumber = 1

  return {
    script(next) {
      current = next
    },

    branches: () => branches,
    commits: () => commits,
    pullRequests: () => pullRequests,

    async createBranch(_repositoryFullName, branch, _baseBranch): Promise<GitHostBranch> {
      const existing = branches.find((candidate) => candidate.name === branch)
      if (existing || current.branchExists) {
        // Returned rather than refused or force-pushed. A job re-run on the
        // same task must land on the same branch — force-pushing over it is
        // how a colleague's review comments end up attached to a diff that no
        // longer exists (AC1).
        return existing ?? { name: branch, baseSha: 'existing-base' }
      }
      const created = { name: branch, baseSha: `base-${branches.length + 1}` }
      branches.push(created)
      return created
    },

    async commit(options): Promise<GitHostCommit> {
      const trailers = options.coAuthors
        .map((author) => `Co-authored-by: ${author}`)
        .join('\n')
      const message = trailers ? `${options.message}\n\n${trailers}` : options.message
      const made = { sha: `sha-${commits.length + 1}`, message }
      commits.push({ ...made, coAuthors: options.coAuthors })
      return made
    },

    async openPullRequest(request: OpenPullRequest): Promise<GitHostPullRequest> {
      // Checked before the refusal script, so a retry of an already-opened pull
      // request succeeds even against a host that would now refuse a new one.
      const already = byKey.get(request.idempotencyKey)
      if (already) return already

      if (current.refusePullRequest) {
        throw new PullRequestRefusedError(
          current.refusePullRequest.message,
          current.refusePullRequest.retryable,
          { branch: request.branch },
        )
      }

      const opened: GitHostPullRequest = {
        number: nextNumber,
        url: `https://git.test/${request.repositoryFullName}/pull/${nextNumber}`,
        branch: request.branch,
      }
      nextNumber += 1
      byKey.set(request.idempotencyKey, opened)
      pullRequests.push({ ...opened, title: request.title, body: request.body })
      return opened
    },
  }
}
