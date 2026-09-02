import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  discoverAuthorizationServerMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type TestClient } from '@chorus/testing'

/**
 * WS-5 AC3, AC4, AC5 — the platform OAuth 2.1 authorization server.
 *
 * Driven by the MCP SDK's own OAuth client rather than by hand-written
 * requests. That is the point of the requirement: the metadata document has to
 * be correct enough for a real client to bootstrap unattended, and a
 * hand-rolled request proves only that the server agrees with the test author.
 * Every step here — discovery, dynamic registration, the PKCE challenge, the
 * code exchange, the refresh — is the library's code, not ours.
 *
 * Personal API tokens, WS-5's other half, are in api-tokens.test.ts.
 */

const ISSUER = 'http://localhost:3000'
const REDIRECT_URI = 'http://localhost:9876/callback'

describe('WS-5 OAuth 2.1 authorization server', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let app: ReturnType<typeof createApp>

  /**
   * The SDK talks to a real URL; this app has no socket. Routing its fetch into
   * the in-process app keeps the library's behaviour genuine while leaving the
   * test hermetic.
   */
  const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = new URL(url.toString())
    return app.request(`${target.pathname}${target.search}`, init)
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    app = createApp({ dbConfig: db.config, mailer, baseUrl: ISSUER })
    client = createTestClient(app, mailer)
  })

  /** Discovery and dynamic registration, as a real client performs them. */
  async function bootstrapClient(): Promise<{
    metadata: AuthorizationServerMetadata
    clientInformation: OAuthClientInformationFull
  }> {
    const metadata = await discoverAuthorizationServerMetadata(ISSUER, { fetchFn })
    if (!metadata) throw new Error('the authorization server published no usable metadata')

    const clientInformation = await registerClient(ISSUER, {
      metadata,
      clientMetadata: {
        client_name: 'Chorus MCP client',
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      fetchFn,
    })
    return { metadata, clientInformation }
  }

  /**
   * The half of the flow a browser performs: the user views the consent screen
   * and approves it for one workspace. Returns the authorization code the
   * server redirected back with.
   */
  async function consent(
    user: Awaited<ReturnType<TestClient['signedInUser']>>,
    authorizationUrl: URL,
    workspaceId: string,
  ): Promise<{ code: string; state: string | null; location: URL }> {
    const shown = await user.get(`${authorizationUrl.pathname}${authorizationUrl.search}`)
    if (shown.status !== 200) {
      throw new Error(`consent screen was not shown: ${shown.status} ${await shown.text()}`)
    }
    const page = await shown.text()
    const requestId = /name="request_id" value="([^"]+)"/.exec(page)?.[1]
    if (!requestId) throw new Error('the consent screen carried no request id')

    const approved = await user.post('/oauth/authorize', {
      requestId,
      workspaceId,
      decision: 'approve',
    })
    if (approved.status !== 302) {
      throw new Error(`consent was not accepted: ${approved.status} ${await approved.text()}`)
    }
    const location = new URL(approved.headers.get('location')!)
    const code = location.searchParams.get('code')
    if (!code) throw new Error(`no authorization code in redirect: ${location}`)
    return { code, state: location.searchParams.get('state'), location }
  }

  it('WS-5 AC3: a client that has never been registered discovers, registers, and completes PKCE', async () => {
    // Given a user with a workspace, and a client that knows only the issuer
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('MCP Consumer')

    // When the client discovers the authorization server
    const { metadata, clientInformation } = await bootstrapClient()

    // Then the metadata is complete enough for it to have proceeded
    expect(metadata.issuer).toBe(ISSUER)
    expect(metadata.code_challenge_methods_supported).toContain('S256')
    expect(metadata.grant_types_supported).toEqual(
      expect.arrayContaining(['authorization_code', 'refresh_token']),
    )
    expect(clientInformation.client_id, 'registration must issue a client id').toBeTruthy()

    // When it starts an authorization with PKCE and the user consents
    const { authorizationUrl, codeVerifier } = await startAuthorization(ISSUER, {
      metadata,
      clientInformation,
      redirectUrl: REDIRECT_URI,
      scope: 'read:artefacts write:artefacts',
      state: 'opaque-state',
    })
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')

    const { code, state } = await consent(ada, authorizationUrl, workspace.id)
    expect(state, 'state must be returned unmodified').toBe('opaque-state')

    // Then the code exchanges for an access and a refresh token
    const tokens = await exchangeAuthorization(ISSUER, {
      metadata,
      clientInformation,
      authorizationCode: code,
      codeVerifier,
      redirectUri: REDIRECT_URI,
      fetchFn,
    })
    expect(tokens.access_token).toBeTruthy()
    expect(tokens.refresh_token, 'a refresh token must be issued').toBeTruthy()
    expect(tokens.token_type.toLowerCase()).toBe('bearer')

    // and the access token authorises a real request, within its scope
    const read = await client.bearer(tokens.access_token).get(`/workspaces/${workspace.id}/members`)
    expect(read.status, await read.clone().text()).toBe(200)
  })

  it('WS-5 AC3: an exchange without the matching code verifier is refused', async () => {
    // Given a completed authorization
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Pkce Enforced')
    const { metadata, clientInformation } = await bootstrapClient()
    const { authorizationUrl } = await startAuthorization(ISSUER, {
      metadata,
      clientInformation,
      redirectUrl: REDIRECT_URI,
      scope: 'read:artefacts',
    })
    const { code } = await consent(ada, authorizationUrl, workspace.id)

    // When the code is presented with a verifier that does not match the challenge
    const stolen = exchangeAuthorization(ISSUER, {
      metadata,
      clientInformation,
      authorizationCode: code,
      codeVerifier: 'a'.repeat(43),
      redirectUri: REDIRECT_URI,
      fetchFn,
    })

    // Then the exchange fails — the code alone is worthless
    await expect(stolen).rejects.toThrow()
  })

  it('WS-5 AC3: an authorization code cannot be exchanged twice', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Codes Are Single Use')
    const { metadata, clientInformation } = await bootstrapClient()
    const { authorizationUrl, codeVerifier } = await startAuthorization(ISSUER, {
      metadata,
      clientInformation,
      redirectUrl: REDIRECT_URI,
      scope: 'read:artefacts',
    })
    const { code } = await consent(ada, authorizationUrl, workspace.id)

    const exchange = () =>
      exchangeAuthorization(ISSUER, {
        metadata,
        clientInformation,
        authorizationCode: code,
        codeVerifier,
        redirectUri: REDIRECT_URI,
        fetchFn,
      })

    expect((await exchange()).access_token).toBeTruthy()
    await expect(exchange()).rejects.toThrow()
  })

  it('WS-5 AC4: presenting a refresh token twice revokes the whole grant, with an audit event', async () => {
    // Given a client holding a refreshed pair of tokens
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Rotation')
    const { metadata, clientInformation } = await bootstrapClient()
    const { authorizationUrl, codeVerifier } = await startAuthorization(ISSUER, {
      metadata,
      clientInformation,
      redirectUrl: REDIRECT_URI,
      scope: 'read:artefacts',
    })
    const { code } = await consent(ada, authorizationUrl, workspace.id)
    const first = await exchangeAuthorization(ISSUER, {
      metadata,
      clientInformation,
      authorizationCode: code,
      codeVerifier,
      redirectUri: REDIRECT_URI,
      fetchFn,
    })

    // When the refresh token is exchanged
    const second = await refreshAuthorization(ISSUER, {
      metadata,
      clientInformation,
      refreshToken: first.refresh_token!,
      fetchFn,
    })
    expect(second.refresh_token, 'refresh must rotate, not be reused').not.toBe(first.refresh_token)

    // and then the *old* one is presented again
    await expect(
      refreshAuthorization(ISSUER, {
        metadata,
        clientInformation,
        refreshToken: first.refresh_token!,
        fetchFn,
      }),
    ).rejects.toThrow()

    // Then the whole grant is dead: the token issued by the honest refresh no
    // longer works either, because we cannot tell which party was the thief.
    const after = await client.bearer(second.access_token).get(`/workspaces/${workspace.id}/members`)
    expect(after.status, 'reuse must revoke the grant, not just the token').toBe(401)

    await expect(
      refreshAuthorization(ISSUER, {
        metadata,
        clientInformation,
        refreshToken: second.refresh_token!,
        fetchFn,
      }),
    ).rejects.toThrow()

    // and the event is recorded, because this is a security incident
    const events = await db.admin.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE workspace_id = $1 AND action = 'oauth.refresh_reused'`,
      [workspace.id],
    )
    expect(events, 'refresh reuse must be audited').toHaveLength(1)
  })

  it('WS-5 AC5: revoking a grant kills its access token on the next request', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Revocable')
    const { metadata, clientInformation } = await bootstrapClient()
    const { authorizationUrl, codeVerifier } = await startAuthorization(ISSUER, {
      metadata,
      clientInformation,
      redirectUrl: REDIRECT_URI,
      scope: 'read:artefacts',
    })
    const { code } = await consent(ada, authorizationUrl, workspace.id)
    const tokens = await exchangeAuthorization(ISSUER, {
      metadata,
      clientInformation,
      authorizationCode: code,
      codeVerifier,
      redirectUri: REDIRECT_URI,
      fetchFn,
    })
    const bearer = client.bearer(tokens.access_token)
    expect((await bearer.get(`/workspaces/${workspace.id}/members`)).status).toBe(200)

    // When the user revokes the grant they gave
    const grants = (await (await ada.get(`/workspaces/${workspace.id}/grants`)).json()) as Array<{
      id: string
      clientName: string
      scopes: string[]
    }>
    expect(grants[0]).toMatchObject({ clientName: 'Chorus MCP client' })
    const revoked = await ada.delete(`/workspaces/${workspace.id}/grants/${grants[0]!.id}`)
    expect(revoked.status).toBe(204)

    // Then the token stops working immediately, with no cache window
    expect((await bearer.get(`/workspaces/${workspace.id}/members`)).status).toBe(401)
  })

  it('WS-5 AC2: an OAuth token is bound by scope and by role, exactly as a personal token is', async () => {
    // Given a member — not an admin — who grants a client write scope
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Ceilings Apply Here Too')
    const bob = await client.memberWithRole(ada, workspace.id, 'member')

    const { metadata, clientInformation } = await bootstrapClient()
    const { authorizationUrl, codeVerifier } = await startAuthorization(ISSUER, {
      metadata,
      clientInformation,
      redirectUrl: REDIRECT_URI,
      scope: 'read:artefacts write:artefacts',
    })
    const { code } = await consent(bob, authorizationUrl, workspace.id)
    const tokens = await exchangeAuthorization(ISSUER, {
      metadata,
      clientInformation,
      authorizationCode: code,
      codeVerifier,
      redirectUri: REDIRECT_URI,
      fetchFn,
    })

    // When the client attempts something only an admin may do
    const refused = await client
      .bearer(tokens.access_token)
      .post(`/workspaces/${workspace.id}/invitations`, { email: 'x@example.test', role: 'member' })

    // Then the grant buys nothing the granter did not already have
    expect(refused.status, "a grant cannot exceed the granter's role").toBe(403)
  })

  it('WS-5: the consent screen names the scopes in plain language', async () => {
    const ada = await client.signedInUser()
    await ada.createWorkspace('Informed Consent')
    const { metadata, clientInformation } = await bootstrapClient()
    const { authorizationUrl } = await startAuthorization(ISSUER, {
      metadata,
      clientInformation,
      redirectUrl: REDIRECT_URI,
      scope: 'read:artefacts run:coding',
    })

    const shown = await ada.get(`${authorizationUrl.pathname}${authorizationUrl.search}`)
    const page = await shown.text()

    expect(page).toContain('Chorus MCP client')
    // Scope strings are not a user interface: a person consenting must be told
    // what they are agreeing to, not shown an identifier.
    expect(page.toLowerCase()).toContain('read')
    expect(page).toMatch(/coding job/i)
    expect(page, 'the raw scope string is not an explanation').not.toMatch(
      /<li>\s*run:coding\s*<\/li>/,
    )
  })

  it('WS-5 AC3: a redirect URI that was not registered is refused before consent', async () => {
    const ada = await client.signedInUser()
    await ada.createWorkspace('Exact Match Only')
    const { clientInformation } = await bootstrapClient()

    // An open redirect here would hand authorization codes to whoever asked.
    const tampered = await ada.get(
      `/oauth/authorize?response_type=code&client_id=${clientInformation.client_id}` +
        `&redirect_uri=${encodeURIComponent('http://evil.test/callback')}` +
        `&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256&scope=read%3Aartefacts`,
    )
    expect(tampered.status).toBe(400)
    expect(await tampered.text()).not.toContain('evil.test/callback?')
  })

  it('WS-5: a consenting user can only grant access to a workspace they belong to', async () => {
    const ada = await client.signedInUser()
    const grace = await client.signedInUser()
    const notAdas = await grace.createWorkspace('Not Adas')
    await ada.createWorkspace('Adas Own')

    const { metadata, clientInformation } = await bootstrapClient()
    const { authorizationUrl } = await startAuthorization(ISSUER, {
      metadata,
      clientInformation,
      redirectUrl: REDIRECT_URI,
      scope: 'read:artefacts',
    })

    const shown = await ada.get(`${authorizationUrl.pathname}${authorizationUrl.search}`)
    const requestId = /name="request_id" value="([^"]+)"/.exec(await shown.text())?.[1]

    const approved = await ada.post('/oauth/authorize', {
      requestId,
      workspaceId: notAdas.id,
      decision: 'approve',
    })
    expect(approved.status, 'consent cannot confer what the granter does not have').toBe(404)
  })

  it('WS-5: a refused consent redirects with an error and issues nothing', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Declined')
    const { metadata, clientInformation } = await bootstrapClient()
    const { authorizationUrl } = await startAuthorization(ISSUER, {
      metadata,
      clientInformation,
      redirectUrl: REDIRECT_URI,
      scope: 'read:artefacts',
      state: 'still-returned',
    })

    const shown = await ada.get(`${authorizationUrl.pathname}${authorizationUrl.search}`)
    const requestId = /name="request_id" value="([^"]+)"/.exec(await shown.text())?.[1]

    const declined = await ada.post('/oauth/authorize', {
      requestId,
      workspaceId: workspace.id,
      decision: 'deny',
    })
    expect(declined.status).toBe(302)

    const location = new URL(declined.headers.get('location')!)
    expect(location.searchParams.get('error')).toBe('access_denied')
    expect(location.searchParams.get('state')).toBe('still-returned')
    expect(location.searchParams.get('code')).toBeNull()

    const grants = await db.admin.query(`SELECT 1 FROM oauth_grants WHERE workspace_id = $1`, [
      workspace.id,
    ])
    expect(grants, 'a refusal must create no grant').toHaveLength(0)
  })
})
