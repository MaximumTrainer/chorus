import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid } from '@chorus/core'
import { createApiTokenService, type ApiTokenService } from '../../src/api-tokens.js'

/**
 * WS-5 — the token service against a real database.
 *
 * One seam: the service and Postgres. What is asserted here is what only exists
 * when both halves are present — that resolution is a hash lookup rather than a
 * scan the application filters afterwards, that row-level security confines a
 * token to its own workspace without the service having to remember to, and
 * that revocation and expiry are evaluated in the same query that finds the
 * token, leaving no window in which a dead credential still works.
 */
describe('WS-5 api token service', () => {
  let db: IsolatedDatabase
  let tokens: ApiTokenService
  const workspaceId = ulid()
  const otherWorkspaceId = ulid()
  let userId: string
  /** A second member of the *same* workspace, so "someone else's token" is not
   *  also "another tenant's token" — two different guarantees. */
  let colleagueId: string

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    tokens = createApiTokenService(db.config)

    await db.admin.seedWorkspace(workspaceId)
    await db.admin.seedWorkspace(otherWorkspaceId)
    const [mine] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1`,
      [workspaceId],
    )
    userId = mine!.user_id

    colleagueId = ulid()
    await db.admin.execute(`INSERT INTO users (id, email, name) VALUES ($1, $2, 'Colleague')`, [
      colleagueId,
      `${colleagueId}@example.test`,
    ])
    await db.admin.execute(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES ($1, $2, $3, 'member')`,
      [ulid(), workspaceId, colleagueId],
    )
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('WS-5 AC1: the plaintext is returned once and never persisted in any column', async () => {
    const issued = await tokens.create({
      workspaceId,
      userId,
      name: 'ci',
      scopes: ['read:artefacts'],
    })

    // Every column, not just the ones the service means to write: a token
    // accidentally copied into `name` would still be a leak.
    const [row] = await db.admin.query<Record<string, unknown>>(
      `SELECT * FROM api_tokens WHERE id = $1`,
      [issued.id],
    )
    expect(JSON.stringify(row)).not.toContain(issued.token.slice(issued.prefix.length))
  })

  it('WS-5 AC2: resolution returns the scopes the token was created with', async () => {
    const issued = await tokens.create({
      workspaceId,
      userId,
      name: 'scoped',
      scopes: ['read:artefacts', 'read:brain'],
    })

    const resolved = await tokens.resolve(workspaceId, issued.token)
    expect(resolved).toMatchObject({
      id: issued.id,
      userId,
      scopes: ['read:artefacts', 'read:brain'],
    })
  })

  it('WS-5 AC5: revocation is evaluated in the lookup, so there is no window', async () => {
    const issued = await tokens.create({
      workspaceId,
      userId,
      name: 'doomed',
      scopes: ['read:artefacts'],
    })
    expect(await tokens.resolve(workspaceId, issued.token)).toBeDefined()

    await tokens.revoke(workspaceId, userId, issued.id)

    expect(await tokens.resolve(workspaceId, issued.token)).toBeUndefined()
  })

  it('WS-5 AC5: revoking twice is not an error, and does not resurrect the token', async () => {
    const issued = await tokens.create({
      workspaceId,
      userId,
      name: 'twice',
      scopes: ['read:artefacts'],
    })
    await tokens.revoke(workspaceId, userId, issued.id)

    // The second revocation must not find a live row to revoke.
    await expect(tokens.revoke(workspaceId, userId, issued.id)).rejects.toThrow(/not found|No such/i)
    expect(await tokens.resolve(workspaceId, issued.token)).toBeUndefined()
  })

  it('WS-5: an expired token does not resolve', async () => {
    const issued = await tokens.create({
      workspaceId,
      userId,
      name: 'expiring',
      scopes: ['read:artefacts'],
      expiresInDays: 1,
    })
    expect(await tokens.resolve(workspaceId, issued.token)).toBeDefined()

    await db.admin.execute(
      `UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [issued.id],
    )
    expect(await tokens.resolve(workspaceId, issued.token)).toBeUndefined()
  })

  it("WS-5: row-level security confines a token to the workspace it was issued for", async () => {
    const issued = await tokens.create({
      workspaceId,
      userId,
      name: 'confined',
      scopes: ['read:artefacts'],
    })

    // The same hash, looked up in the other tenant's context. The service does
    // not filter by workspace itself — the policy does — so this proves the
    // confinement holds even if a future query forgets the predicate.
    expect(await tokens.resolve(otherWorkspaceId, issued.token)).toBeUndefined()
  })

  it('WS-5: a listing shows a user their own tokens, by prefix, and nobody else’s', async () => {
    const mine = await tokens.create({
      workspaceId,
      userId,
      name: 'mine',
      scopes: ['read:artefacts'],
    })
    await tokens.create({
      workspaceId,
      userId: colleagueId,
      name: 'not mine',
      scopes: ['read:artefacts'],
    })

    const listed = await tokens.listFor(workspaceId, userId)
    expect(listed.map((token) => token.id)).toContain(mine.id)
    expect(listed.every((token) => token.userId === userId)).toBe(true)
    expect(listed.find((token) => token.id === mine.id)).toMatchObject({ prefix: mine.prefix })
    expect(JSON.stringify(listed)).not.toContain(mine.token.slice(mine.prefix.length))
  })

  it('WS-5: last use is recorded, and only moves forward', async () => {
    const issued = await tokens.create({
      workspaceId,
      userId,
      name: 'tracked',
      scopes: ['read:artefacts'],
    })
    const unused = await db.admin.query<{ last_used_at: Date | null }>(
      `SELECT last_used_at FROM api_tokens WHERE id = $1`,
      [issued.id],
    )
    expect(unused[0]!.last_used_at, 'a token that has never been used has no last use').toBeNull()

    await tokens.resolve(workspaceId, issued.token)
    const [first] = await db.admin.query<{ last_used_at: Date }>(
      `SELECT last_used_at FROM api_tokens WHERE id = $1`,
      [issued.id],
    )
    expect(first!.last_used_at).not.toBeNull()

    await tokens.resolve(workspaceId, issued.token)
    const [second] = await db.admin.query<{ last_used_at: Date }>(
      `SELECT last_used_at FROM api_tokens WHERE id = $1`,
      [issued.id],
    )
    expect(second!.last_used_at.getTime()).toBeGreaterThanOrEqual(first!.last_used_at.getTime())
  })

  it('WS-5: a value that is not one of ours resolves to nothing rather than failing', async () => {
    expect(await tokens.resolve(workspaceId, 'not-a-token')).toBeUndefined()
    expect(await tokens.resolve(workspaceId, '')).toBeUndefined()
  })

  it('WS-5: a token cannot be created with a scope the system does not define', async () => {
    await expect(
      tokens.create({
        workspaceId,
        userId,
        name: 'invented',
        scopes: ['read:everything'] as never,
      }),
    ).rejects.toThrow(/scope/i)
  })

  it('WS-5: one user cannot revoke another user’s token', async () => {
    const theirs = await tokens.create({
      workspaceId,
      userId: colleagueId,
      name: 'theirs',
      scopes: ['read:artefacts'],
    })

    await expect(tokens.revoke(workspaceId, userId, theirs.id)).rejects.toThrow(/not found|No such/i)
    expect(await tokens.resolve(workspaceId, theirs.token)).toBeDefined()
  })
})
