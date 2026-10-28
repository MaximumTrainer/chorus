import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createCodingJobService, type CodingJobService } from '@chorus/coding'
import { createApp } from '../../src/app.js'
import {
  createFakeGitHost,
  createRecordingMailer,
  createTestClient,
  type FakeGitHost,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * CODE-5 AC7 (#170 AC4) — a pull request waits for `before_external_write`.
 *
 * Opening a pull request writes to somebody else's system, where colleagues
 * will be asked to review it (CLAUDE.md §6.6). For a job a person launched,
 * their launch was their approval of all of it. For a job an agent launched,
 * nobody has yet agreed to the pull request, so under `ask` collection pushes
 * the branch and the diff, then stops. The work is kept, not lost, and the
 * decision either opens exactly one pull request or leaves the branch for a
 * person to deal with.
 */

interface Job {
  id: string
  status: string
  branch: string | null
  pullRequestUrl: string | null
  checkpointId: string | null
  failure: string | null
}

describe('CODE-5 AC7 the before_external_write gate on pull requests', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let gitHost: FakeGitHost
  let jobs: CodingJobService

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    gitHost = createFakeGitHost()
    jobs = createCodingJobService(db.config, {
      gitHost,
      settings: {
        defaultAdapter: 'reference',
        allowedAdapters: ['reference'],
        appBaseUrl: 'https://chorus.test',
        botName: 'Chorus Agent',
        botEmail: 'agent@chorus.test',
      },
    })
    client = createTestClient(createApp({ dbConfig: db.config, mailer, codingJobs: jobs }), mailer)
  })

  async function policy(ada: SignedInUser, workspaceId: string, teamId: string, kind: string, mode: string) {
    const response = await ada.put(`/workspaces/${workspaceId}/teams/${teamId}/policies`, {
      checkpointKind: kind,
      mode,
    })
    expect(response.status, await response.clone().text()).toBe(200)
  }

  /** A team with a repository, a task, and policies: launches pass, pull requests use `externalWrite`. */
  async function world(externalWrite: 'ask' | 'auto' | 'never') {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Gated pull requests')
    const [team] = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{ id: string }>
    const [integration] = await db.admin.query<{ id: string }>(
      `INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'github') RETURNING id`,
      [`int${Date.now()}${Math.floor(Math.random() * 1000)}`, workspace.id],
    )
    await ada.post(`/workspaces/${workspace.id}/teams/${team!.id}/repositories`, {
      integrationId: integration!.id,
      provider: 'github',
      fullName: 'acme/billing',
    })
    await policy(ada, workspace.id, team!.id, 'before_coding_job', 'auto')
    await policy(ada, workspace.id, team!.id, 'before_external_write', externalWrite)
    const task = (await (
      await ada.post(`/workspaces/${workspace.id}/teams/${team!.id}/tasks`, {
        title: 'Split the invoice parser',
        status: 'in_progress',
      })
    ).json()) as { id: string }
    const created = await ada.post(`/workspaces/${workspace.id}/tokens`, {
      name: 'agent',
      scopes: ['read:artefacts', 'write:artefacts', 'run:coding'],
    })
    const token = ((await created.json()) as { token: string }).token
    const launchPath = `/workspaces/${workspace.id}/teams/${team!.id}/tasks/${task.id}/coding-jobs`
    return { ada, workspaceId: workspace.id, taskId: task.id, token, launchPath }
  }

  async function agentLaunch(w: Awaited<ReturnType<typeof world>>): Promise<Job> {
    const response = await client.bearer(w.token).post(w.launchPath, {})
    expect(response.status, await response.clone().text()).toBe(201)
    return (await response.json()) as Job
  }

  /** What the worker does when the sandbox finishes: collect the diff and open the pull request. */
  async function collect(w: Awaited<ReturnType<typeof world>>, job: Job): Promise<Job> {
    return (await jobs.complete({
      workspaceId: w.workspaceId,
      jobId: job.id,
      diff: '--- a/src/billing/parse.ts\n+++ b/src/billing/parse.ts\n',
      summary: 'Extracted parse() and post().',
      testOutput: '12 passed, 0 failed',
      lintOutput: 'no problems',
    })) as unknown as Job
  }

  async function read(w: Awaited<ReturnType<typeof world>>, jobId: string): Promise<Job> {
    return (await (await w.ada.get(`/workspaces/${w.workspaceId}/coding-jobs/${jobId}`)).json()) as Job
  }

  async function decide(w: Awaited<ReturnType<typeof world>>, checkpointId: string, decision: string) {
    return w.ada.post(`/workspaces/${w.workspaceId}/checkpoints/${checkpointId}/decision`, { decision })
  }

  it('CODE-5 AC7: under ask, an agent job pushes its branch and diff but opens no pull request', async () => {
    // Given an agent's job whose diff is collected, and before_external_write set to ask
    const w = await world('ask')
    const job = await agentLaunch(w)

    // When collection reaches the pull request
    const held = await collect(w, job)

    // Then the branch and the diff are pushed and kept
    expect(gitHost.branches().map((branch) => branch.name)).toContain(held.branch)
    expect(gitHost.commits()).toHaveLength(1)
    // and no pull request is opened
    expect(gitHost.pullRequests()).toEqual([])
    expect(held).toMatchObject({ status: 'awaiting_approval', pullRequestUrl: null })
    // and the gate shows exactly what would be opened
    const gate = await w.ada.get(`/workspaces/${w.workspaceId}/checkpoints/${held.checkpointId}`)
    const checkpoint = (await gate.json()) as { kind: string; status: string; payload: Record<string, unknown> }
    expect(checkpoint).toMatchObject({ kind: 'before_external_write', status: 'pending' })
    expect(checkpoint.payload).toMatchObject({ jobId: job.id, branch: held.branch, repository: 'acme/billing' })
    expect(String(checkpoint.payload.body)).toContain('Extracted parse() and post().')
  })

  it('CODE-5 AC7: approving opens exactly one pull request, and the task moves to review', async () => {
    const w = await world('ask')
    const held = await collect(w, await agentLaunch(w))

    expect((await decide(w, held.checkpointId!, 'approve')).status).toBe(200)
    // An approval arriving twice, from another surface, opens nothing more.
    expect((await decide(w, held.checkpointId!, 'approve')).status).toBe(409)

    expect(gitHost.pullRequests()).toHaveLength(1)
    const job = await read(w, held.id)
    expect(job).toMatchObject({ status: 'succeeded', pullRequestUrl: gitHost.pullRequests()[0]!.url })
    const task = (await (await w.ada.get(`/workspaces/${w.workspaceId}/tasks/${w.taskId}`)).json()) as {
      status: string
    }
    expect(task.status).toBe('in_review')
  })

  it('CODE-5 AC7: rejecting opens no pull request and keeps the branch, saying so', async () => {
    const w = await world('ask')
    const held = await collect(w, await agentLaunch(w))

    expect((await decide(w, held.checkpointId!, 'reject')).status).toBe(200)

    expect(gitHost.pullRequests()).toEqual([])
    const job = await read(w, held.id)
    expect(job.status).toBe('failed')
    expect(job.failure).toContain(held.branch!)
  })

  it('CODE-5 AC7: under auto the pull request opens, and the gate it passed is recorded', async () => {
    const w = await world('auto')
    const done = await collect(w, await agentLaunch(w))

    expect(done.status).toBe('succeeded')
    expect(gitHost.pullRequests()).toHaveLength(1)
    const [gate] = await db.admin.query<{ status: string }>(
      `SELECT c.status FROM checkpoints c JOIN coding_jobs j ON j.run_id = c.run_id
        WHERE j.id = $1 AND c.kind = 'before_external_write'`,
      [done.id],
    )
    expect(gate).toMatchObject({ status: 'approved' })
  })

  it('CODE-5 AC7: under never the pull request is not opened and the job says why', async () => {
    const w = await world('never')
    const done = await collect(w, await agentLaunch(w))

    expect(gitHost.pullRequests()).toEqual([])
    expect(done.status).toBe('failed')
    expect(done.failure).toContain('before_external_write')
  })

  it("CODE-5 AC7: a person's own job is not asked again before its pull request", async () => {
    // Given the same ask policy, and a job a senior member launched themself
    const w = await world('ask')
    const launched = await w.ada.post(w.launchPath, {})
    expect(launched.status, await launched.clone().text()).toBe(201)

    // When it is collected, its pull request opens: the launch was the approval
    const done = await collect(w, (await launched.json()) as Job)

    expect(done.status).toBe('succeeded')
    expect(gitHost.pullRequests()).toHaveLength(1)
  })
})
