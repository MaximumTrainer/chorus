import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type TestClient } from '@chorus/testing'

/**
 * WS-4 — roles and permission enforcement.
 *
 * The requirement each route carries is *data*, and this suite is about that
 * data being what actually enforces. A declaration that is merely inspected by
 * a CI check while a hand-written check inside the handler does the real work
 * is the worst of both worlds: it reads as a guarantee and is not one, and the
 * two drift the first time someone edits only the handler.
 *
 * Two acceptance criteria cannot be proved here yet, and are not pretended:
 *
 * - AC1 (coding jobs require seniority) needs a coding-job route. CODE-1 is
 *   Phase 2. The `senior_member` rung is exercised through AC2 instead.
 * - AC5 (MCP and HTTP permit identical sets) needs the MCP server, which is
 *   Phase 1 WP-1.11. The suite that will assert it is table-driven over the
 *   route table already, so adding the tool registry extends it rather than
 *   rewriting it (test/nfr/permissions.test.ts).
 */
describe('WS-4 roles and permission enforcement', () => {
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

  it('WS-4 AC2: a senior member may not change a policy, and an admin may', async () => {
    const owner = await client.signedInUser()
    const workspace = await owner.createWorkspace('Administration')
    const [team] = (await (await owner.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>

    const senior = await client.memberWithRole(owner, workspace.id, 'senior_member')
    const admin = await client.memberWithRole(owner, workspace.id, 'admin')

    const policy = { checkpointKind: 'before_coding_job', mode: 'auto' }

    const refused = await senior.put(`/workspaces/${workspace.id}/teams/${team!.id}/policies`, policy)
    expect(
      refused.status,
      'a senior member must not be able to open a gate that binds their colleagues',
    ).toBe(403)

    const allowed = await admin.put(`/workspaces/${workspace.id}/teams/${team!.id}/policies`, policy)
    expect(allowed.status, await allowed.clone().text()).toBe(200)
  })

  it("WS-4 AC2: a senior member may not change a member's role, and an admin may", async () => {
    const owner = await client.signedInUser()
    const workspace = await owner.createWorkspace('Role Changes')
    const senior = await client.memberWithRole(owner, workspace.id, 'senior_member')
    const admin = await client.memberWithRole(owner, workspace.id, 'admin')
    const subject = await client.memberWithRole(owner, workspace.id, 'member')

    const refused = await senior.patch(
      `/workspaces/${workspace.id}/members/${subject.userId}`,
      { role: 'admin' },
    )
    expect(refused.status).toBe(403)

    const allowed = await admin.patch(`/workspaces/${workspace.id}/members/${subject.userId}`, {
      role: 'senior_member',
    })
    expect(allowed.status, await allowed.clone().text()).toBe(204)
  })

  it('WS-4 AC2: a member may read a team but not create one', async () => {
    const owner = await client.signedInUser()
    const workspace = await owner.createWorkspace('Read Not Write')
    const member = await client.memberWithRole(owner, workspace.id, 'member')

    expect((await member.get(`/workspaces/${workspace.id}/teams`)).status).toBe(200)
    expect((await member.post(`/workspaces/${workspace.id}/teams`, { name: 'Mine' })).status).toBe(
      403,
    )
  })

  it('WS-4 AC3: a team override raises a role in that team and nowhere else', async () => {
    // AC3's shape — permitted in team A, refused in team B — proved with the
    // roles that gate routes which exist today. The coding-job specifics wait
    // for CODE-1.
    const owner = await client.signedInUser()
    const workspace = await owner.createWorkspace('Overrides')
    const alpha = (await (
      await owner.post(`/workspaces/${workspace.id}/teams`, { name: 'Alpha' })
    ).json()) as { id: string }
    const beta = (await (
      await owner.post(`/workspaces/${workspace.id}/teams`, { name: 'Beta' })
    ).json()) as { id: string }

    const plain = await client.memberWithRole(owner, workspace.id, 'member')

    // Before any override, a member may edit neither charter.
    expect((await plain.patch(`/workspaces/${workspace.id}/teams/${alpha.id}`, { charter: 'a' })).status)
      .toBe(403)

    const granted = await owner.put(
      `/workspaces/${workspace.id}/teams/${alpha.id}/members/${plain.userId}`,
      { roleOverride: 'admin' },
    )
    expect(granted.status, await granted.clone().text()).toBe(200)

    const inAlpha = await plain.patch(`/workspaces/${workspace.id}/teams/${alpha.id}`, {
      charter: 'written under an override',
    })
    expect(inAlpha.status, await inAlpha.clone().text()).toBe(200)

    const inBeta = await plain.patch(`/workspaces/${workspace.id}/teams/${beta.id}`, {
      charter: 'should not be permitted',
    })
    expect(inBeta.status, 'an override must not leak beyond its own team').toBe(403)
  })

  it('WS-4 AC3: a team override lowers a role in that team, and cannot strand the team', async () => {
    const owner = await client.signedInUser()
    const workspace = await owner.createWorkspace('Lowering')
    const team = (await (
      await owner.post(`/workspaces/${workspace.id}/teams`, { name: 'Sensitive' })
    ).json()) as { id: string }
    const admin = await client.memberWithRole(owner, workspace.id, 'admin')

    // An override replaces rather than raises: a workspace admin may be
    // deliberately restricted inside a sensitive team.
    const lowered = await owner.put(
      `/workspaces/${workspace.id}/teams/${team.id}/members/${admin.userId}`,
      { roleOverride: 'member' },
    )
    expect(lowered.status, await lowered.clone().text()).toBe(200)
    expect(
      (await admin.patch(`/workspaces/${workspace.id}/teams/${team.id}`, { charter: 'nope' }))
        .status,
    ).toBe(403)

    // But the owner cannot be lowered, or a team could be left with nobody able
    // to administer it — the same hazard WS-2 AC6 guards for the workspace.
    const stranding = await owner.put(
      `/workspaces/${workspace.id}/teams/${team.id}/members/${owner.userId}`,
      { roleOverride: 'member' },
    )
    expect(stranding.status, 'lowering the owner would strand the team').toBe(403)
    expect(
      (await owner.patch(`/workspaces/${workspace.id}/teams/${team.id}`, { charter: 'still mine' }))
        .status,
    ).toBe(200)
  })

  it('WS-4 AC6: the last owner may be demoted only after ownership is transferred', async () => {
    const owner = await client.signedInUser()
    const workspace = await owner.createWorkspace('Succession')
    const heir = await client.memberWithRole(owner, workspace.id, 'admin')

    const premature = await owner.patch(`/workspaces/${workspace.id}/members/${owner.userId}`, {
      role: 'admin',
    })
    expect(premature.status, 'the only owner must not be demotable').toBe(403)

    const transferred = await owner.patch(`/workspaces/${workspace.id}/members/${heir.userId}`, {
      role: 'owner',
    })
    expect(transferred.status, await transferred.clone().text()).toBe(204)

    const now = await owner.patch(`/workspaces/${workspace.id}/members/${owner.userId}`, {
      role: 'admin',
    })
    expect(now.status, 'with a second owner in place, demotion is safe').toBe(204)
  })

  it('WS-4: a denial is audited with the actor and the role that was required', async () => {
    // A misconfigured permission is otherwise invisible: the user sees a 403
    // and nobody can tell whether it was correct.
    const owner = await client.signedInUser()
    const workspace = await owner.createWorkspace('Audited Denials')
    const member = await client.memberWithRole(owner, workspace.id, 'member')

    await member.post(`/workspaces/${workspace.id}/teams`, { name: 'Refused' })

    const [denial] = await db.admin.query<{
      actor_id: string
      action: string
      after: { required: string; held: string; method: string; path: string }
    }>(
      `SELECT actor_id, action, after FROM audit_events
        WHERE workspace_id = $1 AND action = 'access.denied' ORDER BY at DESC LIMIT 1`,
      [workspace.id],
    )

    expect(denial, 'a denial must leave a record').toBeDefined()
    expect(denial!.actor_id).toBe(member.userId)
    expect(denial!.after).toMatchObject({ required: 'admin', held: 'member', method: 'POST' })
  })

  it('WS-4: a non-member is answered not-found, and that is not audited into a workspace they cannot see', async () => {
    // Auditing this would let anyone write rows into any workspace's trail by
    // guessing ids — a denial that becomes an amplification vector.
    const owner = await client.signedInUser()
    const stranger = await client.signedInUser()
    const workspace = await owner.createWorkspace('Not Yours')

    const response = await stranger.get(`/workspaces/${workspace.id}/teams`)
    expect(response.status).toBe(404)

    const denials = await db.admin.query(
      `SELECT 1 FROM audit_events WHERE workspace_id = $1 AND action = 'access.denied'`,
      [workspace.id],
    )
    expect(denials, 'a stranger must not be able to write into this trail').toHaveLength(0)
  })
})
