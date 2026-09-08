import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PullRequestRefusedError,
  ulid,
  type GitHost,
  type Role,
} from '@chorus/core'
import { withTenant, mutate, type DbConfig } from '@chorus/db'
import { branchNameFor, evaluateLaunch, type LaunchVerdict } from './launch.js'
import { pullRequestBody, pullRequestTitle } from './pull-request.js'

/**
 * Coding jobs: launching one, cancelling one, and turning a finished one into a
 * pull request (CODE-1, CODE-5).
 *
 * The two requirements live together because they are the two ends of one
 * thing. Launch decides whether the platform should spend money and write to
 * somebody's repository; collection decides what a reviewer is shown when it
 * did. Splitting them across packages would put the authorisation and its
 * consequence out of each other's sight.
 */

export type CodingJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** The states a task may not have a second job in (CODE-1 AC3). */
export const ACTIVE_STATUSES: readonly CodingJobStatus[] = ['queued', 'running']

export interface CodingJob {
  readonly id: string
  readonly taskId: string
  readonly repositoryId: string
  readonly adapter: string
  readonly status: CodingJobStatus
  readonly branch: string | null
  readonly pullRequestUrl: string | null
  readonly summary: string | null
  readonly failure: string | null
  readonly requestedBy: string
}

export interface LaunchRequest {
  readonly workspaceId: string
  readonly teamId: string
  readonly taskId: string
  readonly actorId: string
  readonly role: Role
  /** Absent means the workspace default (AC6). */
  readonly adapter?: string | undefined
}

export interface LaunchOutcome {
  readonly job: CodingJob
  /** True when an existing active job was returned rather than a new one made. */
  readonly existing: boolean
}

export interface CodingJobsConfig {
  readonly defaultAdapter: string
  readonly allowedAdapters: readonly string[]
  /** Where a task and a brief can be read, for the pull request body. */
  readonly appBaseUrl: string
  readonly botName: string
  readonly botEmail: string
}

export interface CodingJobService {
  launch(request: LaunchRequest): Promise<LaunchOutcome>
  cancel(workspaceId: string, jobId: string, actorId: string): Promise<CodingJob>
  get(workspaceId: string, jobId: string): Promise<CodingJob>
  listForTask(workspaceId: string, taskId: string): Promise<readonly CodingJob[]>
  /** Opens the pull request for a finished job (CODE-5). */
  complete(request: CompleteRequest): Promise<CodingJob>
}

export interface CompleteRequest {
  readonly workspaceId: string
  readonly jobId: string
  readonly diff: string
  readonly summary: string
  readonly testOutput: string
  readonly lintOutput: string
}

interface JobRow {
  id: string
  task_id: string
  repository_id: string
  adapter: string
  status: CodingJobStatus
  branch: string | null
  pull_request_url: string | null
  summary: string | null
  failure: string | null
  requested_by: string
}

function toJob(row: JobRow): CodingJob {
  return {
    id: row.id,
    taskId: row.task_id,
    repositoryId: row.repository_id,
    adapter: row.adapter,
    status: row.status,
    branch: row.branch,
    pullRequestUrl: row.pull_request_url,
    summary: row.summary,
    failure: row.failure,
    requestedBy: row.requested_by,
  }
}

/** Postgres' unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505'

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  )
}

export function createCodingJobService(
  config: DbConfig,
  deps: { readonly gitHost: GitHost; readonly settings: CodingJobsConfig },
): CodingJobService {
  const { settings } = deps

  async function read(workspaceId: string, jobId: string): Promise<CodingJob> {
    const [row] = await withTenant(
      workspaceId,
      (t) =>
        t.query<JobRow>(
          `SELECT id, task_id, repository_id, adapter, status, branch,
                  pull_request_url, summary, failure, requested_by
             FROM coding_jobs WHERE id = $1`,
          [jobId],
        ),
      { config },
    )
    if (!row) throw new NotFoundError(`No coding job "${jobId}".`, { jobId })
    return toJob(row)
  }

  return {
    async launch(request: LaunchRequest): Promise<LaunchOutcome> {
      const adapter = request.adapter ?? settings.defaultAdapter

      const context = await withTenant(
        request.workspaceId,
        async (t) => {
          const [task] = await t.query<{ key: string; title: string; team_id: string }>(
            `SELECT key, title, team_id FROM tasks WHERE id = $1 AND deleted_at IS NULL`,
            [request.taskId],
          )
          if (!task) {
            throw new NotFoundError(`No task "${request.taskId}".`, { taskId: request.taskId })
          }

          const [repository] = await t.query<{ id: string }>(
            `SELECT id FROM repositories
              WHERE team_id = $1 AND deleted_at IS NULL
              ORDER BY created_at, id LIMIT 1`,
            [task.team_id],
          )

          const [active] = await t.query<{ id: string }>(
            `SELECT id FROM coding_jobs
              WHERE task_id = $1 AND status IN ('queued', 'running') LIMIT 1`,
            [request.taskId],
          )

          return { task, repositoryId: repository?.id, activeJobId: active?.id }
        },
        { config },
      )

      const verdict: LaunchVerdict = evaluateLaunch({
        role: request.role,
        repositoryLinked: context.repositoryId !== undefined,
        adapter,
        allowedAdapters: settings.allowedAdapters,
        activeJobId: context.activeJobId,
        taskKey: context.task.key,
        taskTitle: context.task.title,
      })

      if (!verdict.allowed) {
        // An existing job is not a refusal, it is an answer: the caller wanted
        // a job for this task and there is one (AC3).
        if (verdict.existingJobId && verdict.reasons.length === 1) {
          return { job: await read(request.workspaceId, verdict.existingJobId), existing: true }
        }
        // Every reason, in one message. Somebody who fixes one blocker and
        // meets the next has been made to do the work twice.
        const message = verdict.reasons.join(' ')
        throw request.role === 'member' && verdict.reasons.length === 1
          ? new ForbiddenError(message, { reasons: verdict.reasons })
          : new ConflictError(message, { reasons: verdict.reasons })
      }

      const jobId = ulid()
      const branch = branchNameFor(context.task.key, context.task.title)

      try {
        await withTenant(
          request.workspaceId,
          async (t) =>
            // CLAUDE.md §6.3: the audit row is written in the same transaction
            // as the change, so a job that exists is a job somebody is recorded
            // as having asked for.
            mutate(t, {
              workspaceId: request.workspaceId,
              actor: { type: 'user', id: request.actorId },
              action: 'coding_job.launch',
              targetType: 'coding_job',
              targetId: jobId,
              after: { adapter, taskId: request.taskId, branch },
              apply: async () => {
                await t.execute(
                  `INSERT INTO coding_jobs
                     (id, workspace_id, team_id, task_id, repository_id, adapter, branch,
                      requested_by)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                  [
                    jobId,
                    request.workspaceId,
                    context.task.team_id,
                    request.taskId,
                    context.repositoryId,
                    adapter,
                    branch,
                    request.actorId,
                  ],
                )
              },
            }),
          { config, userId: request.actorId },
        )
      } catch (error) {
        // The partial unique index refused it, which means another caller won
        // the race between the check above and this insert — an auto-launch and
        // a click, in practice. Their job is the answer to this request too.
        if (!isUniqueViolation(error)) throw error
        const [winner] = await withTenant(
          request.workspaceId,
          (t) =>
            t.query<JobRow>(
              `SELECT id, task_id, repository_id, adapter, status, branch,
                      pull_request_url, summary, failure, requested_by
                 FROM coding_jobs
                WHERE task_id = $1 AND status IN ('queued', 'running') LIMIT 1`,
              [request.taskId],
            ),
          { config },
        )
        if (!winner) throw error
        return { job: toJob(winner), existing: true }
      }

      return { job: await read(request.workspaceId, jobId), existing: false }
    },

    async cancel(workspaceId, jobId, actorId): Promise<CodingJob> {
      const job = await read(workspaceId, jobId)
      if (!ACTIVE_STATUSES.includes(job.status)) {
        throw new ConflictError(
          `Coding job "${jobId}" is already ${job.status} and cannot be cancelled.`,
          { jobId, status: job.status },
        )
      }

      await withTenant(
        workspaceId,
        async (t) =>
          mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            action: 'coding_job.cancel',
            targetType: 'coding_job',
            targetId: jobId,
            before: { status: job.status },
            after: { status: 'cancelled' },
            apply: async () => {
              await t.execute(
                `UPDATE coding_jobs
                    SET status = 'cancelled', finished_at = now(), updated_at = now()
                  WHERE id = $1`,
                [jobId],
              )
            },
          }),
        { config, userId: actorId },
      )

      return read(workspaceId, jobId)
    },

    get: read,

    async listForTask(workspaceId, taskId): Promise<readonly CodingJob[]> {
      const rows = await withTenant(
        workspaceId,
        (t) =>
          t.query<JobRow>(
            `SELECT id, task_id, repository_id, adapter, status, branch,
                    pull_request_url, summary, failure, requested_by
               FROM coding_jobs WHERE task_id = $1 ORDER BY created_at DESC, id DESC`,
            [taskId],
          ),
        { config },
      )
      return rows.map(toJob)
    },

    async complete(request: CompleteRequest): Promise<CodingJob> {
      const job = await read(request.workspaceId, request.jobId)

      // Already opened: a retried collection returns the same job rather than a
      // second pull request (AC5). Checked here as well as by the host's
      // idempotency key, because the cheapest retry is the one that never
      // reaches the network.
      if (job.pullRequestUrl) return job

      const facts = await withTenant(
        request.workspaceId,
        async (t) => {
          const [task] = await t.query<{
            key: string
            title: string
            acceptance_criteria: unknown
          }>(
            `SELECT key, title, acceptance_criteria FROM tasks WHERE id = $1`,
            [job.taskId],
          )
          const [repository] = await t.query<{ full_name: string; base_branch: string }>(
            `SELECT full_name, base_branch FROM repositories WHERE id = $1`,
            [job.repositoryId],
          )
          const [document] = await t.query<{ to_id: string }>(
            `SELECT to_id FROM artefact_links
              WHERE from_type = 'task' AND from_id = $1 AND to_type = 'document'
              ORDER BY created_at, id LIMIT 1`,
            [job.taskId],
          )
          const [requester] = await t.query<{ email: string }>(
            `SELECT email FROM users WHERE id = $1`,
            [job.requestedBy],
          )
          return { task, repository, documentId: document?.to_id, requester }
        },
        { config },
      )

      if (!facts.task || !facts.repository) {
        throw new NotFoundError(`Coding job "${request.jobId}" has lost its task or repository.`, {
          jobId: request.jobId,
        })
      }

      const branch = job.branch ?? branchNameFor(facts.task.key, facts.task.title)
      const criteria = Array.isArray(facts.task.acceptance_criteria)
        ? (facts.task.acceptance_criteria as Array<{ text?: unknown }>)
            .map((entry) => (typeof entry?.text === 'string' ? entry.text : ''))
            .filter((text) => text !== '')
        : []

      await deps.gitHost.createBranch(
        facts.repository.full_name,
        branch,
        facts.repository.base_branch,
      )

      await deps.gitHost.commit({
        repositoryFullName: facts.repository.full_name,
        branch,
        message: `${facts.task.key}: ${facts.task.title}`,
        diff: request.diff,
        authorName: settings.botName,
        authorEmail: settings.botEmail,
        // The requesting human, beside the bot. History that named only the bot
        // would be dishonest about who asked; only the human, about who wrote.
        coAuthors: facts.requester?.email
          ? [`${facts.requester.email} <${facts.requester.email}>`]
          : [],
      })

      let opened
      try {
        opened = await deps.gitHost.openPullRequest({
          repositoryFullName: facts.repository.full_name,
          branch,
          baseBranch: facts.repository.base_branch,
          title: pullRequestTitle({ ...factsFor(), taskKey: facts.task.key }),
          body: pullRequestBody(factsFor()),
          // The job id: stable across retries of the same job, different for
          // every other job.
          idempotencyKey: job.id,
        })
      } catch (error) {
        if (!(error instanceof PullRequestRefusedError)) throw error
        // The branch and the diff are already pushed and stay pushed (AC6).
        // The job records the specific cause so a retry does not re-run the
        // agent to find out what it already knows.
        await withTenant(
          request.workspaceId,
          (t) =>
            t.execute(
              `UPDATE coding_jobs
                  SET status = 'failed', failure = $2, branch = $3, updated_at = now(),
                      finished_at = now()
                WHERE id = $1`,
              [job.id, error.message, branch],
            ),
          { config },
        )
        throw error
      }

      await withTenant(
        request.workspaceId,
        async (t) =>
          mutate(t, {
            workspaceId: request.workspaceId,
            actor: { type: 'run', id: job.id },
            action: 'coding_job.pull_request_opened',
            targetType: 'coding_job',
            targetId: job.id,
            after: { pullRequestUrl: opened.url, branch },
            apply: async () => {
              await t.execute(
                `UPDATE coding_jobs
                    SET status = 'succeeded', pull_request_url = $2, branch = $3, summary = $4,
                        test_output = $5, updated_at = now(), finished_at = now()
                  WHERE id = $1`,
                [job.id, opened.url, branch, request.summary, request.testOutput],
              )
              // The task follows the work (AC4). A pull request nobody is asked
              // to look at is a pull request nobody looks at.
              await t.execute(
                `UPDATE tasks SET status = 'in_review', updated_at = now() WHERE id = $1`,
                [job.taskId],
              )
            },
          }),
        { config },
      )

      return read(request.workspaceId, job.id)

      function factsFor() {
        return {
          taskKey: facts.task!.key,
          taskTitle: facts.task!.title,
          taskUrl: `${settings.appBaseUrl}/tasks/${job.taskId}`,
          documentUrl: facts.documentId
            ? `${settings.appBaseUrl}/documents/${facts.documentId}`
            : undefined,
          briefUrl: `${settings.appBaseUrl}/coding-jobs/${job.id}/brief`,
          acceptanceCriteria: criteria,
          summary: request.summary,
          testOutput: request.testOutput,
          lintOutput: request.lintOutput,
          adapter: job.adapter,
          requestedBy: facts.requester?.email ?? 'a Chorus user',
        }
      }
    },
  }
}
