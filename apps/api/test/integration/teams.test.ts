import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid } from '@chorus/core'
import { createTeamService, type TeamService } from '../../src/teams.js'

/**
 * WS-3 — the team service against a real database.
 *
 * One seam: the service and Postgres. The properties asserted here are the ones
 * that only exist when both halves are present — a uniqueness index the
 * application cannot talk its way past, a policy write that replaces rather
 * than accumulates, and a team predicate that narrows without becoming a second
 * tenancy boundary.
 */
describe('WS-3 team service', () => {
  let db: IsolatedDatabase
  let teams: TeamService
  const workspaceId = ulid()
  const otherWorkspaceId = ulid()
  let actorId: string
  let otherActorId: string

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    teams = createTeamService(db.config)

    await db.admin.seedWorkspace(workspaceId)
    await db.admin.seedWorkspace(otherWorkspaceId)
    const [mine] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1`,
      [workspaceId],
    )
    const [theirs] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1`,
      [otherWorkspaceId],
    )
    actorId = mine!.user_id
    otherActorId = theirs!.user_id
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('WS-3 AC4: the database refuses a duplicate slug, so uniqueness does not rest on the read', () => {
    // The service reads the taken slugs and then writes, which is a race under
    // concurrency. The index is what actually holds the line, so it is asserted
    // directly rather than trusted.
    return expect(
      db.admin.execute(
        `INSERT INTO teams (id, workspace_id, name, slug)
         SELECT $1, workspace_id, 'Copy', slug FROM teams WHERE workspace_id = $2 LIMIT 1`,
        [ulid(), workspaceId],
      ),
    ).rejects.toThrow(/teams_slug_key|duplicate key/)
  })

  it('WS-3 AC4: a concurrent create of the same name still yields two distinct slugs', async () => {
    const [first, second] = await Promise.all([
      teams.create({ workspaceId, actorId, name: 'Racy' }),
      teams.create({ workspaceId, actorId, name: 'Racy' }),
    ])
    expect(first.slug).not.toBe(second.slug)
    expect([first.slug, second.slug].sort()).toEqual(['racy', 'racy-2'])
  })

  it('WS-3 AC3: listing teams is scoped to one workspace, enforced below the service', async () => {
    await teams.create({ workspaceId: otherWorkspaceId, actorId: otherActorId, name: 'Theirs' })

    const mine = await teams.list(workspaceId)
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.map((team) => team.name)).not.toContain('Theirs')
  })

  it('WS-3 AC3: team membership narrows within a workspace without becoming a second boundary', async () => {
    const alpha = await teams.create({ workspaceId, actorId, name: 'Alpha Scope' })
    const beta = await teams.create({ workspaceId, actorId, name: 'Beta Scope' })

    const outsider = ulid()
    await db.admin.execute(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      outsider,
      `${outsider}@example.test`,
    ])
    await db.admin.execute(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES ($1, $2, $3, 'member')`,
      [ulid(), workspaceId, outsider],
    )

    await teams.addMember({ workspaceId, actorId, teamId: beta.id, userId: outsider })

    expect((await teams.members(workspaceId, alpha.id)).map((m) => m.userId)).not.toContain(outsider)
    expect((await teams.members(workspaceId, beta.id)).map((m) => m.userId)).toContain(outsider)
  })

  it('WS-3: a per-team role override replaces the workspace role, in either direction', async () => {
    // An override that could only raise would make "an admin deliberately
    // restricted in a sensitive team" impossible to express (WS-4 AC3).
    const team = await teams.create({ workspaceId, actorId, name: 'Overrides' })

    const subject = ulid()
    await db.admin.execute(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      subject,
      `${subject}@example.test`,
    ])
    await db.admin.execute(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES ($1, $2, $3, 'admin')`,
      [ulid(), workspaceId, subject],
    )

    await teams.addMember({ workspaceId, actorId, teamId: team.id, userId: subject })
    expect(await teams.roleIn(workspaceId, team.id, subject, 'admin')).toBe('admin')

    await teams.addMember({
      workspaceId,
      actorId,
      teamId: team.id,
      userId: subject,
      roleOverride: 'member',
    })
    expect(
      await teams.roleIn(workspaceId, team.id, subject, 'admin'),
      'an override must be able to lower a role, not only raise it',
    ).toBe('member')

    await teams.addMember({
      workspaceId,
      actorId,
      teamId: team.id,
      userId: subject,
      roleOverride: 'owner',
    })
    expect(await teams.roleIn(workspaceId, team.id, subject, 'admin')).toBe('owner')
  })

  it('WS-4 AC3: an override may not lower an owner, which would strand the team', async () => {
    // Without this, an override could leave a team with nobody able to
    // administer it and no way back short of database surgery — the same hazard
    // WS-2 AC6 guards for the workspace.
    const team = await teams.create({ workspaceId, actorId, name: 'Owner Guard' })
    await teams.addMember({ workspaceId, actorId, teamId: team.id, userId: actorId })

    await expect(
      teams.addMember({
        workspaceId,
        actorId,
        teamId: team.id,
        userId: actorId,
        roleOverride: 'member',
      }),
    ).rejects.toThrow(/unadministrable/)

    expect(
      await teams.roleIn(workspaceId, team.id, actorId, 'owner'),
      'the refused override must not have been partly applied',
    ).toBe('owner')
  })

  it('WS-3 AC5: setting a policy twice replaces the row rather than accumulating contradictions', async () => {
    const team = await teams.create({ workspaceId, actorId, name: 'Policy Upsert' })

    await teams.setPolicy({
      workspaceId,
      actorId,
      teamId: team.id,
      checkpointKind: 'before_coding_job',
      mode: 'auto',
    })
    await teams.setPolicy({
      workspaceId,
      actorId,
      teamId: team.id,
      checkpointKind: 'before_coding_job',
      mode: 'never',
    })

    const rows = await db.admin.query<{ mode: string }>(
      `SELECT mode FROM policies
        WHERE workspace_id = $1 AND team_id = $2 AND checkpoint_kind = 'before_coding_job'
          AND deleted_at IS NULL`,
      [workspaceId, team.id],
    )
    expect(rows, 'two rows for one tier would let insertion order decide the gate').toHaveLength(1)
    expect(rows[0]!.mode).toBe('never')
  })

  it('WS-3 AC5: stored rows resolve in the documented order, team ahead of workflow default', async () => {
    const team = await teams.create({ workspaceId, actorId, name: 'Resolution' })
    const untouched = await teams.create({ workspaceId, actorId, name: 'Resolution Other' })

    await teams.setPolicy({
      workspaceId,
      actorId,
      workflowName: 'implement-task',
      checkpointKind: 'before_external_write',
      mode: 'auto',
    })
    await teams.setPolicy({
      workspaceId,
      actorId,
      teamId: team.id,
      checkpointKind: 'before_external_write',
      mode: 'ask',
    })

    const resolved = await teams.resolvePolicies(workspaceId, team.id, 'implement-task')
    expect(resolved.before_external_write).toMatchObject({ mode: 'ask', source: 'team' })

    const fallthrough = await teams.resolvePolicies(workspaceId, untouched.id, 'implement-task')
    expect(fallthrough.before_external_write).toMatchObject({ mode: 'auto', source: 'workflow' })
    expect(fallthrough.before_coding_job).toMatchObject({ mode: 'ask', source: 'platform' })
  })

  it("WS-3 AC5: another workspace's policies never reach this workspace's resolution", async () => {
    const team = await teams.create({ workspaceId, actorId, name: 'Isolated Policy' })
    await teams.setPolicy({
      workspaceId: otherWorkspaceId,
      actorId: otherActorId,
      workflowName: 'implement-task',
      checkpointKind: 'before_create_artefacts',
      mode: 'never',
    })

    const resolved = await teams.resolvePolicies(workspaceId, team.id, 'implement-task')
    expect(
      resolved.before_create_artefacts,
      "another tenant's policy must not open this tenant's gate",
    ).toMatchObject({ mode: 'ask', source: 'platform' })
  })

  it('WS-3 AC5: a policy scoped to neither a team nor a workflow is refused by the database', async () => {
    // A single row that opened every gate everywhere is the one thing that must
    // not be settable in passing.
    await expect(
      db.admin.execute(
        `INSERT INTO policies (id, workspace_id, checkpoint_kind, mode)
         VALUES ($1, $2, 'before_external_write', 'auto')`,
        [ulid(), workspaceId],
      ),
    ).rejects.toThrow(/policies_scope_declared/)
  })

  it('WS-3: every team mutation writes its audit event in the same transaction', async () => {
    const team = await teams.create({ workspaceId, actorId, name: 'Audit Seam' })
    await teams.update({ workspaceId, actorId, teamId: team.id, charter: 'a charter' })

    const actions = (
      await db.admin.query<{ action: string; target_id: string }>(
        `SELECT action, target_id FROM audit_events
          WHERE workspace_id = $1 AND target_id = $2 ORDER BY at`,
        [workspaceId, team.id],
      )
    ).map((row) => row.action)

    expect(actions).toEqual(['team.create', 'team.update'])
  })

  it('WS-3: a failed team change leaves neither the row nor an audit event behind', async () => {
    // Atomicity in both directions (NFR-5 AC1): no change without a record, and
    // no record without a change.
    const before = await db.admin.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit_events WHERE workspace_id = $1 AND action = 'team.update'`,
      [workspaceId],
    )

    await expect(
      teams.update({ workspaceId, actorId, teamId: ulid(), charter: 'nothing to update' }),
    ).rejects.toThrow()

    const after = await db.admin.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit_events WHERE workspace_id = $1 AND action = 'team.update'`,
      [workspaceId],
    )
    expect(after[0]!.count).toBe(before[0]!.count)
  })
})
