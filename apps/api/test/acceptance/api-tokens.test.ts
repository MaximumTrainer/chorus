import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type TestClient } from '@chorus/testing'

/**
 * WS-5 — personal API tokens.
 *
 * A token is the credential most likely to leak, so these assertions are
 * written from the position that one already has: the plaintext must be
 * unrecoverable from the database, the scope must be a ceiling that holds even
 * for an owner, and revocation must bite on the very next request rather than
 * whenever some cache expires.
 *
 * The OAuth authorization server half of WS-5 (AC3, AC4) is a separate suite.
 */
describe('WS-5 personal API tokens', () => {
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

  it('WS-5 AC1: the plaintext is returned exactly once, and only a hash and prefix are persisted', async () => {
    // Given a signed-in user who owns a workspace
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Token Issuer')

    // When they create a personal token
    const created = await ada.post(`/workspaces/${workspace.id}/tokens`, {
      name: 'ci-pipeline',
      scopes: ['read:artefacts'],
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const token = (await created.json()) as {
      id: string
      name: string
      prefix: string
      scopes: string[]
      token: string
    }

    // Then the plaintext comes back once, and identifiably
    expect(token.token, 'the plaintext must be returned on creation').toMatch(/^chorus_pat_/)
    expect(token.prefix, 'the display prefix must be a prefix of the token').toBe(
      token.token.slice(0, token.prefix.length),
    )

    // and the database holds no copy of it
    const [row] = await db.admin.query<{
      token_hash: string
      token_prefix: string
      scopes: string[]
    }>(`SELECT token_hash, token_prefix, scopes FROM api_tokens WHERE id = $1`, [token.id])
    expect(row, 'the token must be persisted').toBeDefined()
    expect(row!.token_hash).not.toBe(token.token)
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row!.token_prefix).toBe(token.prefix)

    // Nowhere in the row may the secret half of the token appear.
    const secret = token.token.slice(token.prefix.length)
    expect(JSON.stringify(row)).not.toContain(secret)
  })

  it('WS-5 AC1: no endpoint returns the plaintext again', async () => {
    // Given a token that has been created
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Shown Once')
    const created = await ada.post(`/workspaces/${workspace.id}/tokens`, {
      name: 'ci-pipeline',
      scopes: ['read:artefacts'],
    })
    const token = (await created.json()) as { id: string; token: string; prefix: string }

    // When the owner lists their tokens
    const listed = await ada.get(`/workspaces/${workspace.id}/tokens`)
    expect(listed.status).toBe(200)
    const body = await listed.text()

    // Then they see it by prefix, and never its plaintext again
    expect(body).toContain(token.prefix)
    expect(body, 'a listing must never disclose the plaintext').not.toContain(token.token)
    expect((JSON.parse(body) as Array<Record<string, unknown>>)[0]).not.toHaveProperty('token')
  })

  it('WS-5 AC2: a read-scoped token performs a read and is refused a write', async () => {
    // Given an owner — whose role permits everything — holding a read-only token
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Scope Is A Ceiling')
    const created = await ada.post(`/workspaces/${workspace.id}/tokens`, {
      name: 'reader',
      scopes: ['read:artefacts'],
    })
    const { token } = (await created.json()) as { token: string }
    const bearer = client.bearer(token)

    // When it is used for a read the scope covers
    const read = await bearer.get(`/workspaces/${workspace.id}/members`)
    // Then it is allowed
    expect(read.status, await read.clone().text()).toBe(200)

    // When it is used for a write the scope does not cover
    const write = await bearer.post(`/workspaces/${workspace.id}/invitations`, {
      email: 'someone@example.test',
      role: 'member',
    })
    // Then it is refused — although the person holding it is the owner
    expect(write.status, 'a read-only token must not write').toBe(403)
    expect(JSON.stringify(await write.json())).toContain('write:artefacts')
  })

  it("WS-5 AC2: a token's scope never exceeds its holder's role", async () => {
    // Given a plain member holding a token with every scope
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Ceiling Not Floor')
    const bob = await client.memberWithRole(ada, workspace.id, 'member')

    const created = await bob.post(`/workspaces/${workspace.id}/tokens`, {
      name: 'over-scoped',
      scopes: ['read:artefacts', 'write:artefacts', 'run:coding', 'read:brain'],
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const { token } = (await created.json()) as { token: string }

    // When it is used for something only an admin may do
    const refused = await client
      .bearer(token)
      .post(`/workspaces/${workspace.id}/invitations`, { email: 'x@example.test', role: 'member' })

    // Then the scope buys nothing the role does not already grant
    expect(refused.status, 'scope must narrow, never widen').toBe(403)
    expect(JSON.stringify(await refused.json())).toContain('admin')
  })

  it('WS-5 AC2: a token cannot mint another token, so its scope cannot be escalated', async () => {
    // Given an owner holding a token with write scope
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('No Self Issuance')
    const created = await ada.post(`/workspaces/${workspace.id}/tokens`, {
      name: 'writer',
      scopes: ['read:artefacts', 'write:artefacts'],
    })
    const { token } = (await created.json()) as { token: string }

    // When that token is used to issue a second, wider one
    const escalation = await client.bearer(token).post(`/workspaces/${workspace.id}/tokens`, {
      name: 'wider',
      scopes: ['read:artefacts', 'write:artefacts', 'run:coding', 'read:brain'],
    })

    // Then it is refused: token management is a first-party session's business.
    // Otherwise a leaked narrow token held by an admin is a full one.
    expect(escalation.status).toBe(401)
  })

  it('WS-5 AC5: a revoked token is refused on the very next request', async () => {
    // Given a working token
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Immediate Revocation')
    const created = await ada.post(`/workspaces/${workspace.id}/tokens`, {
      name: 'doomed',
      scopes: ['read:artefacts'],
    })
    const { id, token } = (await created.json()) as { id: string; token: string }
    const bearer = client.bearer(token)
    expect((await bearer.get(`/workspaces/${workspace.id}/members`)).status).toBe(200)

    // When it is revoked
    const revoked = await ada.delete(`/workspaces/${workspace.id}/tokens/${id}`)
    expect(revoked.status).toBe(204)

    // Then the next request fails, with no cache window
    const after = await bearer.get(`/workspaces/${workspace.id}/members`)
    expect(after.status, 'revocation must bite immediately').toBe(401)
  })

  it('WS-5: last use is recorded, and an expired token is refused', async () => {
    // Given a token that is used while valid
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Expiry')
    const live = await ada.post(`/workspaces/${workspace.id}/tokens`, {
      name: 'short-lived',
      scopes: ['read:artefacts'],
    })
    const { id, token } = (await live.json()) as { id: string; token: string }
    expect((await client.bearer(token).get(`/workspaces/${workspace.id}/members`)).status).toBe(200)

    // Then its last use is recorded
    const [used] = await db.admin.query<{ last_used_at: Date | null }>(
      `SELECT last_used_at FROM api_tokens WHERE id = $1`,
      [id],
    )
    expect(used!.last_used_at, 'last use must be recorded').not.toBeNull()

    // When it has expired
    await db.admin.query(
      `UPDATE api_tokens SET expires_at = now() - interval '1 hour' WHERE id = $1`,
      [id],
    )

    // Then it is refused
    const after = await client.bearer(token).get(`/workspaces/${workspace.id}/members`)
    expect(after.status).toBe(401)
  })

  it('WS-5: a token is confined to the workspace it was issued for', async () => {
    // Given a user who belongs to two workspaces, with a token for one
    const ada = await client.signedInUser()
    const first = await ada.createWorkspace('Issued Here')
    const second = await ada.createWorkspace('Not Here')
    const created = await ada.post(`/workspaces/${first.id}/tokens`, {
      name: 'confined',
      scopes: ['read:artefacts'],
    })
    const { token } = (await created.json()) as { token: string }

    // When it is presented to the other workspace
    const crossed = await client.bearer(token).get(`/workspaces/${second.id}/members`)

    // Then it is not a credential there, even though its holder is a member
    expect(crossed.status, 'a token must not travel between workspaces').toBe(401)
  })

  it('WS-5: creating and revoking a token are audited, without recording the token', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Audited')
    const created = await ada.post(`/workspaces/${workspace.id}/tokens`, {
      name: 'audited',
      scopes: ['read:artefacts'],
    })
    const { id, token, prefix } = (await created.json()) as {
      id: string
      token: string
      prefix: string
    }
    await ada.delete(`/workspaces/${workspace.id}/tokens/${id}`)

    const events = await db.admin.query<{ action: string; after: Record<string, unknown> }>(
      `SELECT action, after FROM audit_events WHERE workspace_id = $1 AND target_id = $2 ORDER BY at`,
      [workspace.id, id],
    )
    expect(events.map((event) => event.action)).toEqual(['api_token.create', 'api_token.revoke'])

    // The prefix belongs in the trail — it is what makes an event legible
    // months later. The secret half must not be, so the assertion is on that
    // rather than on the scheme, which the prefix necessarily carries.
    const serialised = JSON.stringify(events)
    expect(serialised).toContain(prefix)
    expect(
      serialised,
      'an audit row must never carry the credential it describes',
    ).not.toContain(token.slice(prefix.length))
  })
})
