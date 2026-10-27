import { z } from 'zod'

/**
 * A pull request reported by an agent working outside the platform (MCP-3 AC2).
 *
 * `report_pr` is what keeps the task, its brief and the resulting code
 * connected when Chorus did not do the work itself. The report says where the
 * pull request is and what state it is in; the platform decides whether it
 * belongs to a repository this workspace has connected, and records that the
 * work was done externally — provenance that matters later, when someone asks
 * which changes a coding job produced and which a person's own agent did.
 */

export const PULL_REQUEST_STATUSES = ['open', 'draft', 'merged', 'closed'] as const
export type PullRequestStatus = (typeof PULL_REQUEST_STATUSES)[number]

export const ReportPullRequestSchema = z.object({
  url: z
    .string()
    .url()
    .describe(
      'The pull request’s web address, e.g. https://github.com/acme/widgets/pull/42 or ' +
        'https://gitlab.com/acme/widgets/-/merge_requests/42.',
    ),
  status: z.enum(PULL_REQUEST_STATUSES).describe('The state the pull request is in now.'),
  title: z.string().trim().min(1).max(500).optional().describe('The pull request’s title.'),
})
export type ReportPullRequest = z.infer<typeof ReportPullRequestSchema>

/** A pull request as it appears on a task. */
export interface TaskPullRequest {
  readonly url: string
  readonly status: PullRequestStatus
  /** `external` when an agent reported it; a platform job's own is recorded on the job. */
  readonly source: 'external'
  readonly provider: 'github' | 'gitlab'
  readonly repository: string
  readonly number: number
  readonly title: string | null
  readonly reportedAt: string
}

export interface ParsedPullRequestUrl {
  readonly provider: 'github' | 'gitlab'
  readonly repository: string
  readonly number: number
}

const HOSTS: Readonly<Record<string, ParsedPullRequestUrl['provider']>> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
}

/**
 * Where a pull request lives, read from its address, or undefined when the
 * address is not a pull request on a host Chorus connects to.
 *
 * GitHub's is `/{owner}/{repo}/pull/{n}`; GitLab's is
 * `/{group}/…/{project}/-/merge_requests/{n}`, with any depth of subgroup.
 */
export function parsePullRequestUrl(url: string): ParsedPullRequestUrl | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:') return undefined
  const provider = HOSTS[parsed.hostname.toLowerCase()]
  if (!provider) return undefined

  const parts = parsed.pathname.split('/').filter((part) => part !== '')
  const match =
    provider === 'github'
      ? parts.length === 4 && parts[2] === 'pull'
        ? { repository: parts.slice(0, 2), number: parts[3]! }
        : undefined
      : parts.length >= 5 && parts.at(-3) === '-' && parts.at(-2) === 'merge_requests'
        ? { repository: parts.slice(0, -3), number: parts.at(-1)! }
        : undefined
  if (!match || !/^[1-9]\d*$/.test(match.number)) return undefined

  return { provider, repository: match.repository.join('/'), number: Number(match.number) }
}
