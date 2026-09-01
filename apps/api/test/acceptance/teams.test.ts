import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type TestClient } from '@chorus/testing'

/**
 * WS-3 — teams, charters and checkpoint policies.
 *
 * A team is the boundary at which charter, repositories, trackers and default
 * policies differ. It is deliberately *not* a second tenancy boundary: the
 * security boundary stays the workspace and RLS keys on `workspace_id`, so
 * everything asserted here is ordinary scoping plus a membership check.
 *
 * Two acceptance criteria are only partly assertable today, because the systems
 * that would observe them do not exist yet, and a test that pretended otherwise
 * would be theatre:
 *
 * - AC2 (the charter reaches the agent's assembled prompt) needs an agent turn.
 *   The agent runtime arrives with WP-0.6's walking skeleton; the charter is
 *   stored, bounded and editable here so that work has something to consume.
 * - AC3's artefact half needs tasks and documents (TASK-1, DOC-1, Phase 1) and
 *   its integration half needs INT-1. What exists today is the scoping
 *   mechanism, asserted below over the team-scoped resources there are.
 */
describe('WS-3 teams', () => {
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

  it('WS-3 AC1: a workspace starts with exactly one team, and its creator is a member of it', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Acme Product')

    const listed = await ada.get(`/workspaces/${workspace.id}/teams`)
    expect(listed.status, await listed.clone().text()).toBe(200)

    const teams = (await listed.json()) as Array<{ id: string; name: string; slug: string }>
    expect(teams, 'a new workspace must have exactly one team').toHaveLength(1)
    expect(teams[0]!.slug).toBe('default')

    const members = await ada.get(`/workspaces/${workspace.id}/teams/${teams[0]!.id}/members`)
    expect(members.status).toBe(200)
    const memberIds = ((await members.json()) as Array<{ userId: string }>).map((m) => m.userId)
    expect(memberIds, 'the creator must belong to the default team').toContain(ada.userId)
  })

  it('WS-3 AC1: a second team can be added and is immediately usable', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Two Teams')

    const created = await ada.post(`/workspaces/${workspace.id}/teams`, {
      name: 'Payments',
      charter: 'We own money movement. Never guess at a currency conversion.',
    })
    expect(created.status, await created.clone().text()).toBe(201)

    const team = (await created.json()) as { id: string; slug: string; charter: string }
    expect(team.slug).toBe('payments')

    const fetched = await ada.get(`/workspaces/${workspace.id}/teams/${team.id}`)
    expect(fetched.status).toBe(200)
    expect((await fetched.json()) as { charter: string }).toMatchObject({
      charter: 'We own money movement. Never guess at a currency conversion.',
    })
  })

  it('WS-3 AC2: the charter is stored verbatim and is editable', async () => {
    // The half of AC2 that can be proved today. That the charter then reaches
    // the assembled prompt is asserted by WP-0.6, which is what assembles one.
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Charter Edits')
    const [team] = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>

    const edited = await ada.patch(`/workspaces/${workspace.id}/teams/${team!.id}`, {
      charter: '# Mission\n\nShip weekly. Prefer boring technology.',
    })
    expect(edited.status, await edited.clone().text()).toBe(200)
    expect((await edited.json()) as { charter: string }).toMatchObject({
      charter: '# Mission\n\nShip weekly. Prefer boring technology.',
    })
  })

  it('WS-3 AC2: an oversized charter is refused rather than silently truncated', async () => {
    // The charter is injected into every agent prompt, so an unbounded field is
    // a cost and quality problem. Truncating would corrupt the instruction
    // mid-sentence, which is worse than refusing outright.
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Bounded Charter')

    const refused = await ada.post(`/workspaces/${workspace.id}/teams`, {
      name: 'Verbose',
      charter: 'x'.repeat(8001),
    })
    expect(refused.status).toBe(400)
  })

  it('WS-3 AC4: a colliding team name yields a distinct slug, never a silent collision', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Slugs')

    const first = await ada.post(`/workspaces/${workspace.id}/teams`, { name: 'Growth' })
    const second = await ada.post(`/workspaces/${workspace.id}/teams`, { name: 'Growth' })
    expect(second.status, await second.clone().text()).toBe(201)

    const a = (await first.json()) as { slug: string }
    const b = (await second.json()) as { slug: string }
    expect(a.slug).toBe('growth')
    expect(b.slug, 'the second team must not reuse the first slug').toBe('growth-2')
  })

  it('WS-3 AC4: the same slug may exist in two different workspaces', async () => {
    // Slugs are unique *per workspace*. Global uniqueness would leak the
    // existence of another tenant's team through a name collision.
    const ada = await client.signedInUser()
    const grace = await client.signedInUser()
    const one = await ada.createWorkspace('Workspace One')
    const two = await grace.createWorkspace('Workspace Two')

    const mine = await ada.post(`/workspaces/${one.id}/teams`, { name: 'Platform' })
    const theirs = await grace.post(`/workspaces/${two.id}/teams`, { name: 'Platform' })

    expect(((await mine.json()) as { slug: string }).slug).toBe('platform')
    expect(((await theirs.json()) as { slug: string }).slug).toBe('platform')
  })

  it('WS-3 AC3: team-scoped resources are listed per team, while workspace membership is workspace-wide', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Scoping')
    await ada.post(`/workspaces/${workspace.id}/invitations`, {
      email: 'grace@example.test',
      role: 'senior_member',
    })
    const grace = await client.signedInUser('grace@example.test')
    await grace.post('/invitations/accept', {
      token: client.tokenFrom(client.lastInvitationLink('grace@example.test')!),
    })

    const alpha = (await (
      await ada.post(`/workspaces/${workspace.id}/teams`, { name: 'Alpha' })
    ).json()) as { id: string }
    const beta = (await (
      await ada.post(`/workspaces/${workspace.id}/teams`, { name: 'Beta' })
    ).json()) as { id: string }

    const added = await ada.put(
      `/workspaces/${workspace.id}/teams/${beta.id}/members/${grace.userId}`,
      {},
    )
    expect(added.status, await added.clone().text()).toBe(200)

    const alphaMembers = (
      (await (
        await ada.get(`/workspaces/${workspace.id}/teams/${alpha.id}/members`)
      ).json()) as Array<{ userId: string }>
    ).map((m) => m.userId)
    expect(alphaMembers, "team B's membership must not appear under team A").not.toContain(
      grace.userId,
    )

    const betaMembers = (
      (await (
        await ada.get(`/workspaces/${workspace.id}/teams/${beta.id}/members`)
      ).json()) as Array<{ userId: string }>
    ).map((m) => m.userId)
    expect(betaMembers).toContain(grace.userId)

    // Workspace-level facts stay shared: belonging to one team does not remove
    // you from the workspace, which is where integrations will live.
    const workspaceMembers = (
      (await (await ada.get(`/workspaces/${workspace.id}/members`)).json()) as Array<{
        userId: string
      }>
    ).map((m) => m.userId)
    expect(workspaceMembers).toEqual(expect.arrayContaining([ada.userId, grace.userId]))
  })

  it("WS-3 AC3: another workspace's team returns not-found, not forbidden", async () => {
    const ada = await client.signedInUser()
    const grace = await client.signedInUser()
    const theirs = await grace.createWorkspace('Not Adas')
    const [theirTeam] = (await (await grace.get(`/workspaces/${theirs.id}/teams`)).json()) as Array<{
      id: string
    }>

    const response = await ada.get(`/workspaces/${theirs.id}/teams/${theirTeam!.id}`)
    expect(response.status, 'forbidden would confirm the team exists').toBe(404)
  })

  it('WS-3 AC5: a team policy beats the workflow default, which beats the platform default', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Policies')
    const [defaultTeam] = (await (
      await ada.get(`/workspaces/${workspace.id}/teams`)
    ).json()) as Array<{ id: string }>
    const other = (await (
      await ada.post(`/workspaces/${workspace.id}/teams`, { name: 'Untouched' })
    ).json()) as { id: string }

    // The workflow default: applies to every team that has not overridden it.
    const workflowDefault = await ada.put(`/workspaces/${workspace.id}/policies`, {
      workflowName: 'implement-task',
      checkpointKind: 'before_external_write',
      mode: 'auto',
    })
    expect(workflowDefault.status, await workflowDefault.clone().text()).toBe(200)

    // One team is stricter than the workflow it runs.
    const override = await ada.put(`/workspaces/${workspace.id}/teams/${defaultTeam!.id}/policies`, {
      checkpointKind: 'before_external_write',
      mode: 'ask',
    })
    expect(override.status, await override.clone().text()).toBe(200)

    const resolvedForTeam = (await (
      await ada.get(
        `/workspaces/${workspace.id}/teams/${defaultTeam!.id}/policies?workflow=implement-task`,
      )
    ).json()) as Record<string, { mode: string; source: string }>
    expect(resolvedForTeam.before_external_write, 'the team value must win').toMatchObject({
      mode: 'ask',
      source: 'team',
    })

    const resolvedForOther = (await (
      await ada.get(`/workspaces/${workspace.id}/teams/${other.id}/policies?workflow=implement-task`)
    ).json()) as Record<string, { mode: string; source: string }>
    expect(
      resolvedForOther.before_external_write,
      'a team with no override falls through to the workflow default',
    ).toMatchObject({ mode: 'auto', source: 'workflow' })

    // Nothing configured anywhere: the platform default gates, it does not open.
    expect(resolvedForOther.before_coding_job).toMatchObject({
      mode: 'ask',
      source: 'platform',
    })
  })

  it('WS-3: only an admin may create a team, edit a charter or set a policy', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Team Rights')
    await ada.post(`/workspaces/${workspace.id}/invitations`, {
      email: 'plain@example.test',
      role: 'member',
    })
    const plain = await client.signedInUser('plain@example.test')
    await plain.post('/invitations/accept', {
      token: client.tokenFrom(client.lastInvitationLink('plain@example.test')!),
    })
    const [team] = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>

    expect((await plain.post(`/workspaces/${workspace.id}/teams`, { name: 'Nope' })).status).toBe(
      403,
    )
    expect(
      (await plain.patch(`/workspaces/${workspace.id}/teams/${team!.id}`, { charter: 'mine now' }))
        .status,
    ).toBe(403)
    expect(
      (
        await plain.put(`/workspaces/${workspace.id}/teams/${team!.id}/policies`, {
          checkpointKind: 'before_coding_job',
          mode: 'auto',
        })
      ).status,
      'a member must not be able to open a gate for everyone else',
    ).toBe(403)

    // Reading stays available to any member: the charter is context they work from.
    expect((await plain.get(`/workspaces/${workspace.id}/teams`)).status).toBe(200)
  })

  it('WS-3: team creation, charter edits and policy changes are audited', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Audited Teams')
    const team = (await (
      await ada.post(`/workspaces/${workspace.id}/teams`, { name: 'Audited' })
    ).json()) as { id: string }
    await ada.patch(`/workspaces/${workspace.id}/teams/${team.id}`, { charter: 'new charter' })
    await ada.put(`/workspaces/${workspace.id}/teams/${team.id}/policies`, {
      checkpointKind: 'before_coding_job',
      mode: 'never',
    })

    const actions = (
      await db.admin.query<{ action: string }>(
        `SELECT action FROM audit_events WHERE workspace_id = $1 ORDER BY at`,
        [workspace.id],
      )
    ).map((row) => row.action)

    expect(actions).toEqual(expect.arrayContaining(['team.create', 'team.update', 'policy.set']))
  })

  it('WS-3: an unauthenticated caller cannot read or change teams', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Closed')
    const anonymous = client.anonymous()

    expect((await anonymous.get(`/workspaces/${workspace.id}/teams`)).status).toBe(401)
    expect((await anonymous.post(`/workspaces/${workspace.id}/teams`, { name: 'x' })).status).toBe(
      401,
    )
  })
})
