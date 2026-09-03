import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type TestClient } from '@chorus/testing'

/**
 * WS-3 — linking repositories to a team.
 *
 * The asymmetry under test is the one architecture.md §8.2 chose deliberately:
 * **repositories are team-scoped, integrations are workspace-scoped**. A team
 * says which repository it works in; it reaches the credential for that
 * repository *through* a workspace integration rather than holding one of its
 * own. Getting this backwards would let a team quietly acquire its own
 * credentials, which is the thing the shape exists to prevent.
 */
describe('WS-3 team repositories', () => {
  let db: IsolatedDatabase
  let client: TestClient

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    client = createTestClient(createApp({ dbConfig: db.config, mailer }), mailer)
  })

  /** An owner, their workspace, its default team, and a connected integration. */
  async function workspace() {
    const owner = await client.signedInUser()
    const created = await owner.createWorkspace('Repo Linking')
    const [team] = (await (await owner.get(`/workspaces/${created.id}/teams`)).json()) as Array<{
      id: string
    }>

    // The integration is workspace-level, seeded directly: connecting one is
    // INT-1's flow and not what this suite is about.
    const [integration] = await db.admin.query<{ id: string }>(
      `INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'github') RETURNING id`,
      [`int${Date.now()}${Math.floor(Math.random() * 1000)}`, created.id],
    )

    return { owner, workspaceId: created.id, teamId: team!.id, integrationId: integration!.id }
  }

  it('WS-3: a repository is linked to a team, through a workspace integration', async () => {
    const { owner, workspaceId, teamId, integrationId } = await workspace()

    const linked = await owner.post(`/workspaces/${workspaceId}/teams/${teamId}/repositories`, {
      integrationId,
      provider: 'github',
      fullName: 'acme/widgets',
      defaultBranch: 'main',
    })

    expect(linked.status, await linked.clone().text()).toBe(201)
    const repository = (await linked.json()) as {
      id: string
      fullName: string
      defaultBranch: string
      baseBranch: string
    }
    expect(repository.fullName).toBe('acme/widgets')
    // The branch work starts from, distinct from the default branch, because a
    // team that develops against `develop` should not have its agents branch
    // off `main`.
    expect(repository.baseBranch).toBe('main')

    const listed = await owner.get(`/workspaces/${workspaceId}/teams/${teamId}/repositories`)
    expect((await listed.json()) as unknown[]).toHaveLength(1)
  })

  it('WS-3: the same repository cannot be linked to one team twice', async () => {
    const { owner, workspaceId, teamId, integrationId } = await workspace()
    const body = { integrationId, provider: 'github', fullName: 'acme/widgets' }

    expect((await owner.post(`/workspaces/${workspaceId}/teams/${teamId}/repositories`, body)).status).toBe(201)
    const again = await owner.post(`/workspaces/${workspaceId}/teams/${teamId}/repositories`, body)

    // A duplicate would index the same code twice and double every retrieval
    // result from it.
    expect(again.status).toBe(409)
  })

  it('WS-3: a repository cannot be linked through another workspace’s integration', async () => {
    const mine = await workspace()
    const theirs = await workspace()

    const crossed = await mine.owner.post(
      `/workspaces/${mine.workspaceId}/teams/${mine.teamId}/repositories`,
      { integrationId: theirs.integrationId, provider: 'github', fullName: 'acme/widgets' },
    )

    // Otherwise a workspace could borrow another's credentials by naming its
    // integration id — the credential boundary is the whole point of the shape.
    expect(crossed.status).toBe(404)
  })

  it('WS-3: a repository is scoped to its team, not shared across the workspace', async () => {
    const { owner, workspaceId, teamId, integrationId } = await workspace()
    await owner.post(`/workspaces/${workspaceId}/teams/${teamId}/repositories`, {
      integrationId,
      provider: 'github',
      fullName: 'acme/widgets',
    })

    const second = await owner.post(`/workspaces/${workspaceId}/teams`, { name: 'Platform' })
    const other = (await second.json()) as { id: string }

    const listed = await owner.get(`/workspaces/${workspaceId}/teams/${other.id}/repositories`)
    expect((await listed.json()) as unknown[], 'a team sees only its own repositories').toHaveLength(0)
  })

  it('WS-3: a repository can be unlinked', async () => {
    const { owner, workspaceId, teamId, integrationId } = await workspace()
    const created = await owner.post(`/workspaces/${workspaceId}/teams/${teamId}/repositories`, {
      integrationId,
      provider: 'github',
      fullName: 'acme/widgets',
    })
    const { id } = (await created.json()) as { id: string }

    expect(
      (await owner.delete(`/workspaces/${workspaceId}/teams/${teamId}/repositories/${id}`)).status,
    ).toBe(204)
    expect((await (await owner.get(`/workspaces/${workspaceId}/teams/${teamId}/repositories`)).json()) as unknown[]).toHaveLength(0)
  })

  it('WS-3: a member may read the linked repositories but not change them', async () => {
    const { owner, workspaceId, teamId, integrationId } = await workspace()
    const member = await client.memberWithRole(owner, workspaceId, 'member')

    expect((await member.get(`/workspaces/${workspaceId}/teams/${teamId}/repositories`)).status).toBe(200)
    const attempted = await member.post(
      `/workspaces/${workspaceId}/teams/${teamId}/repositories`,
      { integrationId, provider: 'github', fullName: 'acme/widgets' },
    )
    expect(attempted.status).toBe(403)
  })

  it('WS-3: linking and unlinking are audited', async () => {
    const { owner, workspaceId, teamId, integrationId } = await workspace()
    const created = await owner.post(`/workspaces/${workspaceId}/teams/${teamId}/repositories`, {
      integrationId,
      provider: 'github',
      fullName: 'acme/widgets',
    })
    const { id } = (await created.json()) as { id: string }
    await owner.delete(`/workspaces/${workspaceId}/teams/${teamId}/repositories/${id}`)

    const events = await db.admin.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE workspace_id = $1 AND target_id = $2 ORDER BY at`,
      [workspaceId, id],
    )
    expect(events.map((event) => event.action)).toEqual(['repository.link', 'repository.unlink'])
  })

  it('WS-3: an unsupported provider is refused rather than stored', async () => {
    const { owner, workspaceId, teamId, integrationId } = await workspace()

    const refused = await owner.post(`/workspaces/${workspaceId}/teams/${teamId}/repositories`, {
      integrationId,
      provider: 'bitbucket',
      fullName: 'acme/widgets',
    })
    expect(refused.status).toBe(400)
  })
})
