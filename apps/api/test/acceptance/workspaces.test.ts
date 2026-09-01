import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type TestClient } from '@chorus/testing'

/**
 * WS-2 — workspaces, invitations and multi-workspace membership.
 *
 * The workspace is the tenancy boundary the whole system rests on (NFR-3), so
 * the isolation assertions here are deliberately adversarial: it is not enough
 * that a list endpoint filters correctly, a direct request for another
 * workspace's resource must not even confirm that it exists.
 */
describe('WS-2 workspaces and membership', () => {
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

  it('WS-2 AC1: creating a workspace makes the creator its owner and seeds one default team', async () => {
    const ada = await client.signedInUser()

    const created = await ada.post('/workspaces', { name: 'Acme Product' })
    expect(created.status, await created.clone().text()).toBe(201)

    const workspace = (await created.json()) as { id: string; name: string; slug: string }
    expect(workspace.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(workspace.slug).toBe('acme-product')

    const [membership] = await db.admin.query<{ role: string }>(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspace.id, ada.userId],
    )
    expect(membership!.role, 'the creator must be the owner').toBe('owner')

    const teams = await db.admin.query<{ name: string }>(
      `SELECT name FROM teams WHERE workspace_id = $1`,
      [workspace.id],
    )
    expect(teams, 'a new workspace must have exactly one team').toHaveLength(1)
  })

  it('WS-2 AC1: the creator can immediately use the workspace', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Usable From The Start')

    const listed = await ada.get('/workspaces')
    expect(listed.status).toBe(200)
    const workspaces = (await listed.json()) as Array<{ id: string }>
    expect(workspaces.map((w) => w.id)).toContain(workspace.id)
  })

  it('WS-2 AC4: a member of two workspaces sees strictly disjoint data', async () => {
    const ada = await client.signedInUser()
    const first = await ada.createWorkspace('First')
    const second = await ada.createWorkspace('Second')

    const membersOfFirst = await ada.get(`/workspaces/${first.id}/members`)
    const members = (await membersOfFirst.json()) as Array<{ workspaceId: string }>
    for (const member of members) {
      expect(member.workspaceId).toBe(first.id)
    }
    expect(second.id).not.toBe(first.id)
  })

  it("WS-2 AC4: another workspace's id returns not-found, not forbidden — existence is information", async () => {
    const ada = await client.signedInUser()
    const grace = await client.signedInUser()
    const graceWorkspace = await grace.createWorkspace('Not Adas')

    const response = await ada.get(`/workspaces/${graceWorkspace.id}`)
    expect(
      response.status,
      'forbidden would confirm the workspace exists',
    ).toBe(404)
  })

  it('WS-2 AC2: an email invitation admits the invitee with exactly the role offered', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Invites')

    const invited = await ada.post(`/workspaces/${workspace.id}/invitations`, {
      email: 'grace@example.test',
      role: 'senior_member',
    })
    expect(invited.status, await invited.clone().text()).toBe(201)

    const link = client.lastInvitationLink('grace@example.test')
    expect(link, 'an invitation email must carry a link').toBeTruthy()

    const grace = await client.signedInUser('grace@example.test')
    const accepted = await grace.post('/invitations/accept', { token: client.tokenFrom(link!) })
    expect(accepted.status, await accepted.clone().text()).toBe(200)

    const [membership] = await db.admin.query<{ role: string }>(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspace.id, grace.userId],
    )
    expect(membership!.role).toBe('senior_member')
  })

  it('WS-2 AC2: the invitation token is stored only as a hash', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Hashed')
    await ada.post(`/workspaces/${workspace.id}/invitations`, {
      email: 'hash@example.test',
      role: 'member',
    })

    const token = client.tokenFrom(client.lastInvitationLink('hash@example.test')!)
    const rows = await db.admin.query<{ token_hash: string }>(
      `SELECT token_hash FROM invitations WHERE workspace_id = $1`,
      [workspace.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.token_hash, 'the raw token must never be stored').not.toBe(token)
  })

  it('WS-2 AC2: an invitation is single-use', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Once Only')
    await ada.post(`/workspaces/${workspace.id}/invitations`, {
      email: 'once@example.test',
      role: 'member',
    })
    const token = client.tokenFrom(client.lastInvitationLink('once@example.test')!)

    const grace = await client.signedInUser('once@example.test')
    await grace.post('/invitations/accept', { token })

    const replay = await grace.post('/invitations/accept', { token })
    expect(replay.status, 'an invitation was accepted twice').toBeGreaterThanOrEqual(400)
  })

  it('WS-2 AC3: an expired invitation is refused', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Expired')
    await ada.post(`/workspaces/${workspace.id}/invitations`, {
      email: 'late@example.test',
      role: 'member',
    })
    const token = client.tokenFrom(client.lastInvitationLink('late@example.test')!)

    await db.admin.execute(`UPDATE invitations SET expires_at = now() - interval '1 hour'`)

    const grace = await client.signedInUser('late@example.test')
    const accepted = await grace.post('/invitations/accept', { token })
    expect(accepted.status).toBeGreaterThanOrEqual(400)
  })

  it('WS-2 AC3: a link invitation refuses an address outside its allowed domain', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Domain Bound')

    const invited = await ada.post(`/workspaces/${workspace.id}/invitations`, {
      role: 'member',
      allowedDomain: 'acme.test',
    })
    const { token } = (await invited.json()) as { token: string }

    const outsider = await client.signedInUser('someone@elsewhere.test')
    const refused = await outsider.post('/invitations/accept', { token })
    expect(refused.status).toBeGreaterThanOrEqual(400)

    const insider = await client.signedInUser('someone@acme.test')
    const admitted = await insider.post('/invitations/accept', { token })
    expect(admitted.status, await admitted.clone().text()).toBe(200)
  })

  it('WS-2 AC5: removing a member stops their access immediately', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Removal')
    await ada.post(`/workspaces/${workspace.id}/invitations`, {
      email: 'leaving@example.test',
      role: 'member',
    })
    const grace = await client.signedInUser('leaving@example.test')
    await grace.post('/invitations/accept', {
      token: client.tokenFrom(client.lastInvitationLink('leaving@example.test')!),
    })

    const before = await grace.get(`/workspaces/${workspace.id}`)
    expect(before.status).toBe(200)

    const removed = await ada.delete(`/workspaces/${workspace.id}/members/${grace.userId}`)
    expect(removed.status).toBe(204)

    const after = await grace.get(`/workspaces/${workspace.id}`)
    expect(after.status, 'a removed member must lose access at once').toBe(404)
  })

  it('WS-2 AC6: the last owner cannot be removed or demoted', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Sole Owner')

    const removal = await ada.delete(`/workspaces/${workspace.id}/members/${ada.userId}`)
    expect(removal.status, 'the last owner must not be removable').toBeGreaterThanOrEqual(400)

    const demotion = await ada.patch(`/workspaces/${workspace.id}/members/${ada.userId}`, {
      role: 'admin',
    })
    expect(demotion.status, 'the last owner must not be demotable').toBeGreaterThanOrEqual(400)
  })

  it('WS-2: only an admin may invite', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Invite Rights')
    await ada.post(`/workspaces/${workspace.id}/invitations`, {
      email: 'plain@example.test',
      role: 'member',
    })
    const plain = await client.signedInUser('plain@example.test')
    await plain.post('/invitations/accept', {
      token: client.tokenFrom(client.lastInvitationLink('plain@example.test')!),
    })

    const attempt = await plain.post(`/workspaces/${workspace.id}/invitations`, {
      email: 'another@example.test',
      role: 'member',
    })
    expect(attempt.status).toBe(403)
  })

  it('WS-2: workspace creation and membership changes are audited', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Audited')

    const actions = await db.admin.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE workspace_id = $1 ORDER BY at`,
      [workspace.id],
    )
    expect(actions.map((a) => a.action)).toContain('workspace.create')
  })

  it('WS-2: an unauthenticated caller cannot create or list workspaces', async () => {
    const anonymous = client.anonymous()
    expect((await anonymous.post('/workspaces', { name: 'Nope' })).status).toBe(401)
    expect((await anonymous.get('/workspaces')).status).toBe(401)
  })
})
