import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  UnauthorizedError,
  discoverAuthorizationServerMetadata,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import {
  createRecordingMailer,
  createTestClient,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * MCP-1 — the MCP endpoint, as a real client meets it.
 *
 * Every connection here is made by the MCP SDK's own client and transport,
 * because the requirement is explicit that a bespoke harness will pass while
 * real clients fail (ADR-0012). The SDK is pointed at nothing but the server's
 * URL: it finds the protected-resource metadata, the authorization server,
 * registers itself, runs PKCE and lists tools, and the test only plays the part
 * of the person clicking "approve".
 *
 * Tools themselves are MCP-2 and MCP-3. What is proved here is that a client
 * can reach the point of asking for them.
 */

const ISSUER = 'http://localhost:3000'
const REDIRECT_URI = 'http://localhost:9876/callback'

/**
 * The SDK's client transport, typed as the `Transport` its client accepts.
 *
 * The SDK declares its optional properties without `| undefined`, which this
 * repository's `exactOptionalPropertyTypes` reads as a mismatch between the
 * SDK's own two types. The object is exactly what the SDK's client expects;
 * only the compiler setting differs.
 */
function asTransport(transport: StreamableHTTPClientTransport): Transport {
  return transport as unknown as Transport
}

describe('MCP-1 Streamable HTTP endpoint', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let app: ReturnType<typeof createApp>
  /** The clock sessions age against, moved by hand (CLAUDE.md §5). */
  let clock: number

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
    clock = Date.parse('2026-09-30T09:00:00Z')
    const mailer = createRecordingMailer()
    app = createApp({
      dbConfig: db.config,
      mailer,
      baseUrl: ISSUER,
      mcp: { idleTimeoutMs: 30 * 60 * 1000, now: () => clock },
    })
    client = createTestClient(app, mailer)
  })

  /**
   * An OAuth client provider that keeps everything in memory, as a desktop
   * client would keep it in its own store. "Redirecting" records the URL so
   * the test can play the user's browser.
   */
  function memoryProvider(scope = 'read:artefacts'): OAuthClientProvider & {
    authorizationUrl?: URL
  } {
    let info: OAuthClientInformationMixed | undefined
    let tokens: OAuthTokens | undefined
    let verifier = ''
    const provider: OAuthClientProvider & { authorizationUrl?: URL } = {
      get redirectUrl() {
        return REDIRECT_URI
      },
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: 'MCP-1 acceptance client',
          redirect_uris: [REDIRECT_URI],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope,
        }
      },
      clientInformation: () => info,
      saveClientInformation: (value) => {
        info = value
      },
      tokens: () => tokens,
      saveTokens: (value) => {
        tokens = value
      },
      redirectToAuthorization: (url) => {
        provider.authorizationUrl = url
      },
      saveCodeVerifier: (value) => {
        verifier = value
      },
      codeVerifier: () => verifier,
    }
    return provider
  }

  /** The person's half of the flow: view the consent screen and approve it. */
  async function approve(user: SignedInUser, url: URL, workspaceId: string): Promise<string> {
    const shown = await user.get(`${url.pathname}${url.search}`)
    expect(shown.status, await shown.clone().text()).toBe(200)
    const requestId = /name="request_id" value="([^"]+)"/.exec(await shown.text())?.[1]
    expect(requestId, 'the consent screen carried no request id').toBeDefined()

    const approved = await user.post('/oauth/authorize', {
      requestId,
      workspaceId,
      decision: 'approve',
    })
    expect(approved.status, await approved.clone().text()).toBe(302)
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')
    expect(code, 'no authorization code in the redirect').toBeTruthy()
    return code!
  }

  /** A client connected over OAuth, as a first-time user of it would get it. */
  async function connectedOverOAuth(user: SignedInUser, workspaceId: string): Promise<Client> {
    const provider = memoryProvider()
    const url = new URL(`${ISSUER}/mcp`)

    const first = new StreamableHTTPClientTransport(url, { authProvider: provider, fetch: fetchFn })
    const mcp = new Client({ name: 'mcp-1-acceptance', version: '1.0.0' })
    await expect(mcp.connect(asTransport(first))).rejects.toBeInstanceOf(UnauthorizedError)
    expect(provider.authorizationUrl, 'the client was never sent to authorize').toBeDefined()

    const code = await approve(user, provider.authorizationUrl!, workspaceId)
    await first.finishAuth(code)

    const second = new StreamableHTTPClientTransport(url, { authProvider: provider, fetch: fetchFn })
    const connected = new Client({ name: 'mcp-1-acceptance', version: '1.0.0' })
    await connected.connect(asTransport(second))
    return connected
  }

  /** A client connected with a personal token, as a script would be. */
  async function connectedWithToken(url: string, token: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: fetchFn,
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
    const mcp = new Client({ name: 'mcp-1-script', version: '1.0.0' })
    await mcp.connect(asTransport(transport))
    return mcp
  }

  async function personalToken(user: SignedInUser, workspaceId: string): Promise<string> {
    const created = await user.post(`/workspaces/${workspaceId}/tokens`, {
      name: 'mcp-script',
      scopes: ['read:artefacts'],
    })
    expect(created.status, await created.clone().text()).toBe(201)
    return ((await created.json()) as { token: string }).token
  }

  it('MCP-1: a real MCP client registers dynamically, completes PKCE, and lists tools', async () => {
    // Given a user with a workspace, and a client that knows only the server URL
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('MCP Consumer')

    // When the client connects, is sent to authorize, and the user approves
    const mcp = await connectedOverOAuth(ada, workspace.id)

    // Then it is connected, and can ask what the server offers
    const tools = await mcp.listTools()
    expect(tools.tools).toEqual([])
    expect(mcp.getServerCapabilities()?.tools, 'tools must be advertised').toBeDefined()
    await mcp.close()
  })

  it('MCP-1: an unauthenticated request is told where to authenticate', async () => {
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain(
      `resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`,
    )

    const metadata = (await (
      await app.request('/.well-known/oauth-protected-resource/mcp')
    ).json()) as { resource: string; authorization_servers: string[] }
    expect(metadata.resource).toBe(`${ISSUER}/mcp`)
    expect(metadata.authorization_servers).toEqual([ISSUER])
  })

  it('MCP-1 AC2: a code exchange without the matching PKCE verifier is refused', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('PKCE')
    const metadata = await discoverAuthorizationServerMetadata(ISSUER, { fetchFn })
    const clientInformation = await registerClient(ISSUER, {
      metadata: metadata!,
      clientMetadata: memoryProvider().clientMetadata,
      fetchFn,
    })
    const { authorizationUrl } = await startAuthorization(ISSUER, {
      metadata: metadata!,
      clientInformation,
      redirectUrl: REDIRECT_URI,
      scope: 'read:artefacts',
    })
    const code = await approve(ada, authorizationUrl, workspace.id)

    await expect(
      exchangeAuthorization(ISSUER, {
        metadata: metadata!,
        clientInformation,
        authorizationCode: code,
        codeVerifier: 'not-the-verifier-that-made-the-challenge-at-all-00000',
        redirectUri: REDIRECT_URI,
        fetchFn,
      }),
    ).rejects.toThrow()
  })

  it('MCP-1 AC3: a personal token establishes a session at its workspace URL', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Scripts')
    const token = await personalToken(ada, workspace.id)

    const mcp = await connectedWithToken(`${ISSUER}/workspaces/${workspace.id}/mcp`, token)

    expect((await mcp.listTools()).tools).toEqual([])
    await mcp.close()
  })

  it('MCP-1 AC3: a personal token is refused at another workspace', async () => {
    const ada = await client.signedInUser()
    const mine = await ada.createWorkspace('Mine')
    const bob = await client.signedInUser()
    const theirs = await bob.createWorkspace('Theirs')
    const token = await personalToken(ada, mine.id)

    const refused = await app.request(`/workspaces/${theirs.id}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'wrong-workspace', version: '0.0.1' },
        },
      }),
    })

    // Unauthenticated, not forbidden: a personal token is looked up inside the
    // workspace the path names, so in any other workspace it simply does not
    // exist — the same answer every HTTP route gives it.
    expect(refused.status).toBe(401)
    expect(refused.headers.get('www-authenticate')).toContain('resource_metadata=')
  })

  it('MCP-1 AC3: a personal token at /mcp is told which URL to use instead', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Wrong door')
    const token = await personalToken(ada, workspace.id)

    const response = await app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })

    expect(response.status).toBe(401)
    expect(await response.text()).toContain('/workspaces/{workspaceId}/mcp')
  })

  it("MCP-1 AC5: one user's session id is not honoured for another", async () => {
    const ada = await client.signedInUser()
    const adaSpace = await ada.createWorkspace('Ada')
    const bob = await client.signedInUser()
    const bobSpace = await bob.createWorkspace('Bob')
    const adaToken = await personalToken(ada, adaSpace.id)
    const bobToken = await personalToken(bob, bobSpace.id)

    const adas = await connectedWithToken(`${ISSUER}/workspaces/${adaSpace.id}/mcp`, adaToken)
    const sessionId = (adas.transport as StreamableHTTPClientTransport).sessionId
    expect(sessionId).toBeTruthy()

    // Bob presents Ada's session id with his own, valid credential
    const hijack = await app.request(`/workspaces/${bobSpace.id}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bobToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId!,
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    })

    expect(hijack.status).toBe(404)
    // And Ada's session is untouched by the attempt
    expect((await adas.listTools()).tools).toEqual([])
    await adas.close()
  })

  it('MCP-1 AC5: an idle session expires', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Idle')
    const token = await personalToken(ada, workspace.id)
    const mcp = await connectedWithToken(`${ISSUER}/workspaces/${workspace.id}/mcp`, token)

    clock += 31 * 60 * 1000

    // A client whose session has gone is told so, and must initialize again
    await expect(mcp.listTools()).rejects.toThrow(/404|session/i)
  })

  it('MCP-1 AC6: a client asking for an unsupported version is offered a supported one', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Versions')
    const token = await personalToken(ada, workspace.id)

    const response = await app.request(`/workspaces/${workspace.id}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '1999-01-01',
          capabilities: {},
          clientInfo: { name: 'from-the-past', version: '0.0.1' },
        },
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    const body = await response.text()
    // Answered as SSE or JSON; either way the negotiated version is named.
    expect(body).toContain(`"protocolVersion":"${LATEST_PROTOCOL_VERSION}"`)
  })

  it('MCP-1 AC6: a request declaring an unsupported protocol version is refused with a reason', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Mismatch')
    const token = await personalToken(ada, workspace.id)
    const mcp = await connectedWithToken(`${ISSUER}/workspaces/${workspace.id}/mcp`, token)
    const sessionId = (mcp.transport as StreamableHTTPClientTransport).sessionId!

    const response = await app.request(`/workspaces/${workspace.id}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '1999-01-01',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    })

    expect(response.status).toBe(400)
    expect(await response.text()).toMatch(/protocol version/i)
    await mcp.close()
  })
})
