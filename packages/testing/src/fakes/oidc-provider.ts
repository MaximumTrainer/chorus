import { createServer, type Server } from 'node:http'
import {
  createHash,
  randomBytes,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto'
import type { AddressInfo } from 'node:net'

/**
 * A minimal, standards-shaped OIDC provider for tests (CLAUDE.md §4).
 *
 * Shipped rather than improvised per suite: WS-1 needs it for sign-in and
 * account linking, MCP-1 needs it for the authorization-code flow, and EXT-1
 * needs it for the extension's sign-in. Three hand-rolled stubs would drift,
 * and the differences between them would be invisible.
 *
 * It exposes real discovery, JWKS and token endpoints so the client under test
 * exercises the flow it would in production — a stub that simply returns a
 * canned identity would pass while the real integration was broken.
 */

export interface StubOidcUser {
  readonly sub: string
  readonly email: string
  readonly name?: string
  /**
   * Whether the provider asserts the address as verified. WS-1 AC4 turns on
   * this claim: linking on an unverified provider email would let anyone who
   * can register at a permissive provider take over a Chorus account.
   */
  readonly emailVerified: boolean
}

export interface StubOidcProvider {
  readonly issuer: string
  readonly clientId: string
  readonly clientSecret: string
  /** The identity returned for the next authorization. */
  setUser(user: StubOidcUser): void
  close(): Promise<void>
}

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url')

/** An RSA key pair, generated once per provider instance. */
function generateKeyPair(): { privateKey: string; jwk: Record<string, unknown>; kid: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const pub = createPublicKey(publicKey)
  const jwk = pub.export({ format: 'jwk' }) as Record<string, unknown>
  const kid = createHash('sha256').update(JSON.stringify(jwk)).digest('hex').slice(0, 16)
  return { privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' }, kid }
}

function signJwt(payload: Record<string, unknown>, privateKey: string, kid: string): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))
  const body = base64url(JSON.stringify(payload))
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), createPrivateKey(privateKey))
  return `${header}.${body}.${base64url(signature)}`
}

export async function startStubOidcProvider(
  initialUser: StubOidcUser,
): Promise<StubOidcProvider> {
  const { privateKey, jwk, kid } = generateKeyPair()
  const clientId = 'chorus-test-client'
  const clientSecret = randomBytes(16).toString('hex')

  let user = initialUser
  /** Authorization codes issued but not yet exchanged. Single use. */
  const codes = new Map<string, { nonce?: string; redirectUri: string }>()

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const issuer = `http://${req.headers.host}`
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (url.pathname === '/.well-known/openid-configuration') {
      json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'email', 'profile'],
        code_challenge_methods_supported: ['S256'],
      })
      return
    }

    if (url.pathname === '/jwks') {
      json(200, { keys: [jwk] })
      return
    }

    if (url.pathname === '/authorize') {
      // Consent is assumed: the flow under test is the client's, not a human's.
      const code = randomBytes(16).toString('hex')
      const redirectUri = url.searchParams.get('redirect_uri') ?? ''
      const nonce = url.searchParams.get('nonce')
      codes.set(code, { redirectUri, ...(nonce ? { nonce } : {}) })

      const location = new URL(redirectUri)
      location.searchParams.set('code', code)
      const state = url.searchParams.get('state')
      if (state) location.searchParams.set('state', state)

      res.writeHead(302, { location: location.toString() })
      res.end()
      return
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const params = new URLSearchParams(body)
        const code = params.get('code') ?? ''
        const issued = codes.get(code)
        if (!issued) {
          json(400, { error: 'invalid_grant', error_description: 'unknown or reused code' })
          return
        }
        // Authorization codes are single-use, as the specification requires.
        codes.delete(code)

        const now = Math.floor(Date.now() / 1000)
        const idToken = signJwt(
          {
            iss: issuer,
            sub: user.sub,
            aud: clientId,
            iat: now,
            exp: now + 300,
            email: user.email,
            email_verified: user.emailVerified,
            name: user.name ?? user.email,
            ...(issued.nonce ? { nonce: issued.nonce } : {}),
          },
          privateKey,
          kid,
        )
        json(200, {
          access_token: randomBytes(16).toString('hex'),
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: idToken,
          scope: 'openid email profile',
        })
      })
      return
    }

    if (url.pathname === '/userinfo') {
      json(200, {
        sub: user.sub,
        email: user.email,
        email_verified: user.emailVerified,
        name: user.name ?? user.email,
      })
      return
    }

    json(404, { error: 'not_found' })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    issuer: `http://127.0.0.1:${port}`,
    clientId,
    clientSecret,
    setUser(next) {
      user = next
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
