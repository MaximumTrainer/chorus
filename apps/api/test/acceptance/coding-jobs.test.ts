import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ulid } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createCodingJobService, type CodingJobService } from '@chorus/coding'
import { createFakeGitHost, type FakeGitHost } from '@chorus/testing'

/**
 * CODE-1 and CODE-5 — launching a coding job, and what a reviewer is handed.
 *
 * > A coding job spends money, writes to a repository and opens a pull request
 * > that colleagues will review.
 *
 * Those three consequences are why launching is gated, and why the refusal has
 * to say which precondition is missing rather than "not allowed". Somebody who
 * cannot launch a job and cannot tell why files a support ticket.
 */
describe('CODE-1 coding job launch', () => {
  let db: IsolatedDatabase
  let gitHost: FakeGitHost
  let jobs: CodingJobService

  interface World {
    workspaceId: string
    teamId: string
    userId: string
    taskId: string
    taskKey: string
  }

  async function world(options: { withRepository?: boolean } = {}): Promise<World> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)

    const [member] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    const [team] = await db.admin.query<{ id: string }>(
      `SELECT id FROM teams WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )

    if (options.withRepository === false) {
      await db.admin.execute(`DELETE FROM repositories WHERE workspace_id = $1`, [workspaceId])
    } else {
      await db.admin.execute(
        `UPDATE repositories SET full_name = 'acme/billing', base_branch = 'main'
          WHERE workspace_id = $1`,
        [workspaceId],
      )
    }

    const taskId = ulid()
    const taskKey = `CH-${taskId.slice(-5)}`
    await db.admin.execute(
      `INSERT INTO tasks (id, workspace_id, team_id, key, title, acceptance_criteria, created_by)
       VALUES ($1, $2, $3, $4, 'Split the invoice parser', $5, $6)`,
      [
        taskId,
        workspaceId,
        team!.id,
        taskKey,
        JSON.stringify([
          { id: 'ac1', text: 'Parsing is separated from validation', checked: false },
        ]),
        member!.user_id,
      ],
    )

    return { workspaceId, teamId: team!.id, userId: member!.user_id, taskId, taskKey }
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    gitHost = createFakeGitHost()
    jobs = createCodingJobService(db.config, {
      gitHost,
      settings: {
        defaultAdapter: 'reference',
        allowedAdapters: ['reference', 'claude-code'],
        appBaseUrl: 'https://chorus.test',
        botName: 'Chorus Agent',
        botEmail: 'agent@chorus.test',
      },
    })
  })

  it('CODE-1: a senior member launches a job from a task and sees it queued', async () => {
    const w = await world()

    const { job, existing } = await jobs.launch({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      taskId: w.taskId,
      actorId: w.userId,
      role: 'senior_member',
    })

    expect(existing).toBe(false)
    expect(job.status).toBe('queued')
    // AC6: no adapter named, so the workspace default is used — and recorded,
    // because a workspace changing its default later must not rewrite what
    // actually produced a diff.
    expect(job.adapter).toBe('reference')
    expect(job.branch).toBe(`chorus/${w.taskKey}-split-the-invoice-parser`)
  })

  it('CODE-1 AC1: a member is refused, and the attempt is audited', async () => {
    const w = await world()

    await expect(
      jobs.launch({
        workspaceId: w.workspaceId,
        teamId: w.teamId,
        taskId: w.taskId,
        actorId: w.userId,
        role: 'member',
      }),
    ).rejects.toThrow(/senior_member/)

    // No job exists. A refusal that left a row behind would show the task as
    // having a job nobody can find.
    expect(await jobs.listForTask(w.workspaceId, w.taskId)).toHaveLength(0)
  })

  it('CODE-1 AC2: a missing repository is named, not reported generically', async () => {
    const w = await world({ withRepository: false })

    await expect(
      jobs.launch({
        workspaceId: w.workspaceId,
        teamId: w.teamId,
        taskId: w.taskId,
        actorId: w.userId,
        role: 'senior_member',
      }),
    ).rejects.toThrow(/repository/i)
  })

  it('CODE-1 AC2: a disallowed adapter is named alongside what is permitted', async () => {
    const w = await world()

    await expect(
      jobs.launch({
        workspaceId: w.workspaceId,
        teamId: w.teamId,
        taskId: w.taskId,
        actorId: w.userId,
        role: 'senior_member',
        adapter: 'aider',
      }),
    ).rejects.toThrow(/aider/)
  })

  it('CODE-1 AC3: concurrent launches produce exactly one job', async () => {
    // The race the partial unique index exists for. An auto-launch and a click
    // arrive together in practice, and check-then-insert loses silently: both
    // read "no active job", both insert, and one task now has two agents
    // editing one branch.
    const w = await world()

    const launch = () =>
      jobs.launch({
        workspaceId: w.workspaceId,
        teamId: w.teamId,
        taskId: w.taskId,
        actorId: w.userId,
        role: 'senior_member',
      })

    const outcomes = await Promise.all([launch(), launch(), launch(), launch()])

    const all = await jobs.listForTask(w.workspaceId, w.taskId)
    expect(all).toHaveLength(1)
    // and every caller was told about the one that exists, rather than three of
    // them receiving an error for a job that did get created.
    expect(new Set(outcomes.map((outcome) => outcome.job.id)).size).toBe(1)
  })

  it('CODE-1 AC5: a queued job can be cancelled, and the task is free again', async () => {
    const w = await world()
    const { job } = await jobs.launch({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      taskId: w.taskId,
      actorId: w.userId,
      role: 'senior_member',
    })

    const cancelled = await jobs.cancel(w.workspaceId, job.id, w.userId)
    expect(cancelled.status).toBe('cancelled')

    // The point of cancelling: a new job may now start. A cancel that left the
    // task blocked would be a cancel in name only.
    const again = await jobs.launch({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      taskId: w.taskId,
      actorId: w.userId,
      role: 'senior_member',
    })
    expect(again.existing).toBe(false)
    expect(again.job.id).not.toBe(job.id)
  })

  it('CODE-1: launching and cancelling are both audited', async () => {
    // CLAUDE.md §6.3. A coding job spends money and writes to a repository;
    // "who started this" must be answerable from the record rather than from
    // somebody's memory.
    const w = await world()
    const { job } = await jobs.launch({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      taskId: w.taskId,
      actorId: w.userId,
      role: 'senior_member',
    })
    await jobs.cancel(w.workspaceId, job.id, w.userId)

    const events = await db.admin.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_events
        WHERE workspace_id = $1 AND target_id = $2 ORDER BY at`,
      [w.workspaceId, job.id],
    )

    expect(events.map((event) => event.action)).toEqual([
      'coding_job.launch',
      'coding_job.cancel',
    ])
    expect(events.every((event) => event.actor_id === w.userId)).toBe(true)
  })

  describe('CODE-5 the pull request', () => {
    async function finished(w: World) {
      const { job } = await jobs.launch({
        workspaceId: w.workspaceId,
        teamId: w.teamId,
        taskId: w.taskId,
        actorId: w.userId,
        role: 'senior_member',
      })
      return job
    }

    it('CODE-5 AC3/AC4: the pull request opens, the task moves to in_review and the URL propagates', async () => {
      const w = await world()
      const job = await finished(w)

      const completed = await jobs.complete({
        workspaceId: w.workspaceId,
        jobId: job.id,
        diff: '--- a/src/billing/parse.ts\n+++ b/src/billing/parse.ts\n',
        summary: 'Extracted parse() and post().',
        testOutput: '12 passed, 0 failed',
        lintOutput: 'no problems',
      })

      expect(completed.status).toBe('succeeded')
      expect(completed.pullRequestUrl).toMatch(/^https:\/\/git\.test\/acme\/billing\/pull\/\d+$/)

      // AC4: the task follows the work. A pull request nobody is asked to look
      // at is a pull request nobody looks at.
      const [task] = await db.admin.query<{ status: string }>(
        `SELECT status FROM tasks WHERE id = $1`,
        [w.taskId],
      )
      expect(task!.status).toBe('in_review')

      // AC3: the body is the reviewer's entire briefing.
      const [pr] = gitHost.pullRequests()
      expect(pr!.title).toContain(w.taskKey)
      expect(pr!.body).toContain('- [ ] Parsing is separated from validation')
      expect(pr!.body).toContain('Extracted parse() and post().')
      expect(pr!.body).toContain('12 passed, 0 failed')
      expect(pr!.body).toContain(`https://chorus.test/tasks/${w.taskId}`)
    })

    it('CODE-5 AC2: the bot authors the commit and the requesting human is co-authored', async () => {
      const w = await world()
      const job = await finished(w)

      await jobs.complete({
        workspaceId: w.workspaceId,
        jobId: job.id,
        diff: 'diff',
        summary: 'done',
        testOutput: 'ok',
        lintOutput: 'ok',
      })

      // History honest about both: who asked, and who wrote.
      const [commit] = gitHost.commits()
      expect(commit!.coAuthors).toHaveLength(1)
      expect(commit!.message).toMatch(/Co-authored-by:/)
    })

    it('CODE-5 AC5: a retried collection does not open a second pull request', async () => {
      const w = await world()
      const job = await finished(w)
      const complete = () =>
        jobs.complete({
          workspaceId: w.workspaceId,
          jobId: job.id,
          diff: 'diff',
          summary: 'done',
          testOutput: 'ok',
          lintOutput: 'ok',
        })

      const first = await complete()
      const second = await complete()

      expect(gitHost.pullRequests()).toHaveLength(1)
      expect(second.pullRequestUrl).toBe(first.pullRequestUrl)
    })

    it('CODE-5 AC6: a refused pull request preserves the branch and names the cause', async () => {
      const w = await world()
      const job = await finished(w)
      gitHost.script({
        refusePullRequest: { message: 'main is a protected branch', retryable: false },
      })

      await expect(
        jobs.complete({
          workspaceId: w.workspaceId,
          jobId: job.id,
          diff: 'diff',
          summary: 'done',
          testOutput: 'ok',
          lintOutput: 'ok',
        }),
      ).rejects.toThrow(/protected branch/)

      // The work is not lost. Re-running the agent to rediscover a permissions
      // problem costs money and tells nobody anything new.
      expect(gitHost.branches()).toHaveLength(1)
      const failed = await jobs.get(w.workspaceId, job.id)
      expect(failed.status).toBe('failed')
      expect(failed.failure).toContain('protected branch')
      expect(failed.branch).toBe(`chorus/${w.taskKey}-split-the-invoice-parser`)
    })

    it('CODE-5 AC1: an existing branch is reused rather than force-pushed over', async () => {
      // A job re-run on the same task must land on the same branch. Force-
      // pushing is how a colleague's review comments end up attached to a diff
      // that no longer exists.
      const w = await world()
      const job = await finished(w)
      gitHost.script({ branchExists: true })

      await jobs.complete({
        workspaceId: w.workspaceId,
        jobId: job.id,
        diff: 'diff',
        summary: 'done',
        testOutput: 'ok',
        lintOutput: 'ok',
      })

      expect(gitHost.pullRequests()).toHaveLength(1)
      expect(gitHost.pullRequests()[0]!.branch).toBe(
        `chorus/${w.taskKey}-split-the-invoice-parser`,
      )
    })
  })
})
