import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { OAUTH_SCHEMES, ulid } from '@chorus/core'
import { createHash, randomBytes } from 'node:crypto'
import { createOAuthService, OAuthError, type OAuthService } from '../../src/oauth.js'

/**
 * WS-5 AC4, AC5 — the authorization server against a real database.
 *
 * One seam: the service and Postgres. The properties here are the ones that
 * only exist when both halves are present, and the one that matters most is
 * **durability of a refusal**. Revoking a grant and then throwing is the
 * obvious way to write AC4 and it is wrong: the throw rolls the revocation back,
 * so the incident is detected, recorded nowhere, and acted on not at all. Only a
 * test that looks at the database *after* the rejection can see that.
 */
describe('WS-5 oauth service', () => {
  let db: IsolatedDatabase
  let oauth: OAuthService
  const workspaceId = ulid()
  const otherWorkspaceId = ulid()
  let userId: string

  const REDIRECT_URI = 'http://localhost:9876/callback'

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    oauth = createOAuthService(db.config)

    await db.admin.seedWorkspace(workspaceId)
    await db.admin.seedWorkspace(otherWorkspaceId)
    const [mine] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1`,
      [workspaceId],
    )
    userId = mine!.user_id
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  /** A registered client, a consented grant, and the first pair of tokens. */
  async function grantedTokens(scope = 'read:artefacts') {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')

    const client = await oauth.registerClient({
      client_name: 'Integration Client',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
    })

    const request = await oauth.beginAuthorization({
      clientId: client.clientId,
      userId,
      redirectUri: REDIRECT_URI,
      scope,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      responseType: 'code',
    })

    const { code } = await oauth.approve(request.id, userId, workspaceId)
    const tokens = await oauth.exchangeCode({
      clientId: client.clientId,
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT_URI,
    })
    return { client, tokens, verifier, code }
  }

  it('WS-5 AC4: reusing a refresh token revokes the grant, and the revocation survives the refusal', async () => {
    // Given a client that has rotated its refresh token once
    const { client, tokens } = await grantedTokens()
    const rotated = await oauth.refresh({
      clientId: client.clientId,
      refreshToken: tokens.refreshToken,
    })
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken)

    // When the spent refresh token is presented again
    await expect(
      oauth.refresh({ clientId: client.clientId, refreshToken: tokens.refreshToken }),
    ).rejects.toBeInstanceOf(OAuthError)

    // Then the revocation is *in the database* — not rolled back with the throw
    const [grant] = await db.admin.query<{ revoked_at: Date | null }>(
      `SELECT g.revoked_at FROM oauth_grants g
         JOIN oauth_tokens t ON t.grant_id = g.id
        WHERE t.token_hash = $1`,
      [createHash('sha256').update(tokens.refreshToken, 'utf8').digest('hex')],
    )
    expect(grant!.revoked_at, 'the grant must actually be revoked').not.toBeNull()

    const live = await db.admin.query(
      `SELECT 1 FROM oauth_tokens t
         JOIN oauth_grants g ON g.id = t.grant_id
        WHERE g.workspace_id = $1 AND t.revoked_at IS NULL AND g.id = (
          SELECT grant_id FROM oauth_tokens WHERE token_hash = $2
        )`,
      [workspaceId, createHash('sha256').update(tokens.refreshToken, 'utf8').digest('hex')],
    )
    expect(live, 'no token under a revoked grant may remain live').toHaveLength(0)

    // and so is the audit event, for the same reason
    const events = await db.admin.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE workspace_id = $1 AND action = 'oauth.refresh_reused'`,
      [workspaceId],
    )
    expect(events.length, 'the incident must be recorded').toBeGreaterThan(0)
  })

  it('WS-5 AC4: the honest client loses access too, because we cannot tell it from the thief', async () => {
    const { client, tokens } = await grantedTokens()
    const rotated = await oauth.refresh({
      clientId: client.clientId,
      refreshToken: tokens.refreshToken,
    })

    // The rotated token is working before the reuse.
    expect(await oauth.resolveAccessToken(workspaceId, rotated.accessToken)).toBeDefined()

    await expect(
      oauth.refresh({ clientId: client.clientId, refreshToken: tokens.refreshToken }),
    ).rejects.toBeInstanceOf(OAuthError)

    expect(
      await oauth.resolveAccessToken(workspaceId, rotated.accessToken),
      'a grant revoked for reuse must take every token with it',
    ).toBeUndefined()
    await expect(
      oauth.refresh({ clientId: client.clientId, refreshToken: rotated.refreshToken }),
    ).rejects.toBeInstanceOf(OAuthError)
  })

  it('WS-5 AC4: rotation revokes the access token it replaces', async () => {
    // Otherwise a stolen pair keeps working for the rest of the access token's
    // hour, and rotation buys nothing until it expires.
    const { client, tokens } = await grantedTokens()
    expect(await oauth.resolveAccessToken(workspaceId, tokens.accessToken)).toBeDefined()

    await oauth.refresh({ clientId: client.clientId, refreshToken: tokens.refreshToken })

    expect(await oauth.resolveAccessToken(workspaceId, tokens.accessToken)).toBeUndefined()
  })

  it('WS-5 AC3: replaying an authorization code revokes the grant, durably', async () => {
    const { client, code, verifier } = await grantedTokens()

    await expect(
      oauth.exchangeCode({
        clientId: client.clientId,
        code,
        codeVerifier: verifier,
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toBeInstanceOf(OAuthError)

    const [grant] = await db.admin.query<{ revoked_at: Date | null }>(
      `SELECT g.revoked_at FROM oauth_grants g
         JOIN oauth_tokens t ON t.grant_id = g.id
        WHERE t.token_hash = $1 AND t.kind = 'code'`,
      [createHash('sha256').update(code, 'utf8').digest('hex')],
    )
    expect(grant!.revoked_at, 'a replayed code must revoke its grant for real').not.toBeNull()
  })

  it('WS-5 AC5: revoking a grant stops its access token in the same instant', async () => {
    const { tokens } = await grantedTokens()
    const [grant] = await db.admin.query<{ id: string }>(
      `SELECT id FROM oauth_grants WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [workspaceId],
    )

    expect(await oauth.resolveAccessToken(workspaceId, tokens.accessToken)).toBeDefined()
    await oauth.revokeGrant(workspaceId, userId, grant!.id)
    expect(await oauth.resolveAccessToken(workspaceId, tokens.accessToken)).toBeUndefined()
  })

  it('WS-5: an access token minted for one workspace is not a credential in another', async () => {
    const { tokens } = await grantedTokens()

    // Two independent barriers: the token names its own workspace, and the
    // row-level security policy would not surface the row anyway.
    expect(await oauth.resolveAccessToken(otherWorkspaceId, tokens.accessToken)).toBeUndefined()
  })

  it('WS-5 AC3: a code cannot be exchanged by a different client than it was issued to', async () => {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')

    const honest = await oauth.registerClient({
      client_name: 'Honest',
      redirect_uris: [REDIRECT_URI],
    })
    const impostor = await oauth.registerClient({
      client_name: 'Impostor',
      redirect_uris: [REDIRECT_URI],
    })

    const request = await oauth.beginAuthorization({
      clientId: honest.clientId,
      userId,
      redirectUri: REDIRECT_URI,
      scope: 'read:artefacts',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      responseType: 'code',
    })
    const { code } = await oauth.approve(request.id, userId, workspaceId)

    await expect(
      oauth.exchangeCode({
        clientId: impostor.clientId,
        code,
        codeVerifier: verifier,
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toBeInstanceOf(OAuthError)
  })

  it('WS-5 AC3: a `plain` challenge is refused at the authorization request', async () => {
    const client = await oauth.registerClient({
      client_name: 'Downgrader',
      redirect_uris: [REDIRECT_URI],
    })

    // A client that can talk the server down to `plain` has defeated PKCE
    // without touching the exchange.
    await expect(
      oauth.beginAuthorization({
        clientId: client.clientId,
        userId,
        redirectUri: REDIRECT_URI,
        scope: 'read:artefacts',
        codeChallenge: 'whatever',
        codeChallengeMethod: 'plain',
        responseType: 'code',
      }),
    ).rejects.toBeInstanceOf(OAuthError)
  })

  it('WS-5: an authorization request belongs to the user who began it', async () => {
    const client = await oauth.registerClient({
      client_name: 'Bound',
      redirect_uris: [REDIRECT_URI],
    })
    const request = await oauth.beginAuthorization({
      clientId: client.clientId,
      userId,
      redirectUri: REDIRECT_URI,
      scope: 'read:artefacts',
      codeChallenge: createHash('sha256').update('x', 'ascii').digest('base64url'),
      codeChallengeMethod: 'S256',
      responseType: 'code',
    })

    // Another person holding the request id cannot answer it, so a stolen id is
    // not a forged consent.
    const [stranger] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1`,
      [otherWorkspaceId],
    )
    expect(await oauth.pending(request.id, stranger!.user_id)).toBeUndefined()
    expect(await oauth.pending(request.id, userId)).toBeDefined()
  })

  it('WS-5: an unregistered redirect URI is refused, so codes cannot be redirected away', async () => {
    const client = await oauth.registerClient({
      client_name: 'Exact',
      redirect_uris: [REDIRECT_URI],
    })

    await expect(
      oauth.beginAuthorization({
        clientId: client.clientId,
        userId,
        redirectUri: 'http://evil.test/callback',
        scope: 'read:artefacts',
        codeChallenge: createHash('sha256').update('x', 'ascii').digest('base64url'),
        codeChallengeMethod: 'S256',
        responseType: 'code',
      }),
    ).rejects.toBeInstanceOf(OAuthError)
  })

  it('WS-5: a secret of the wrong kind is never honoured', async () => {
    const { client, tokens } = await grantedTokens()

    // An access token offered as a refresh token, and vice versa. Both must be
    // refused on their scheme alone, before any lookup.
    await expect(
      oauth.refresh({ clientId: client.clientId, refreshToken: tokens.accessToken }),
    ).rejects.toBeInstanceOf(OAuthError)
    expect(await oauth.resolveAccessToken(workspaceId, tokens.refreshToken)).toBeUndefined()
    expect(tokens.accessToken.startsWith(OAUTH_SCHEMES.access)).toBe(true)
    expect(tokens.refreshToken.startsWith(OAUTH_SCHEMES.refresh)).toBe(true)
  })

  it('WS-5: a grant cannot be revoked by anyone but the person who gave it', async () => {
    await grantedTokens()
    const [grant] = await db.admin.query<{ id: string }>(
      `SELECT id FROM oauth_grants WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [workspaceId],
    )
    const [stranger] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1`,
      [otherWorkspaceId],
    )

    await expect(
      oauth.revokeGrant(workspaceId, stranger!.user_id, grant!.id),
    ).rejects.toThrow(/No such grant/)
  })
})
