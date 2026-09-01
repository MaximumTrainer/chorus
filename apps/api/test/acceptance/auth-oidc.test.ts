import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import {
  createRecordingMailer,
  startStubOidcProvider,
  type RecordingMailer,
  type StubOidcProvider,
} from '@chorus/testing'

/**
 * WS-1 AC3, AC4 — generic OIDC sign-in and account linking.
 *
 * Exercised against a real discovery document, JWKS and token endpoint, so the
 * client runs the flow it would in production. A stub returning a canned
 * identity would pass while the real integration was broken.
 */
describe('WS-1 OIDC authentication', () => {
  let db: IsolatedDatabase
  let oidc: StubOidcProvider
  let mailer: RecordingMailer

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    oidc = await startStubOidcProvider({
      sub: 'provider-subject-1',
      email: `oidc-${Date.now()}@example.test`,
      name: 'Ada Lovelace',
      emailVerified: true,
    })
  }, 120_000)

  afterAll(async () => {
    await oidc?.close()
    await db?.drop()
  })

  const appFor = () => {
    mailer = createRecordingMailer()
    return createApp({
      dbConfig: db.config,
      mailer,
      oidc: {
        issuer: oidc.issuer,
        clientId: oidc.clientId,
        clientSecret: oidc.clientSecret,
      },
    })
  }

  /**
   * Drive the authorization-code flow the way a browser would, carrying the
   * cookie across the round trip. The state cookie set at sign-in is what the
   * callback validates against; dropping it makes the callback fail silently
   * and redirect home, which looks like success until nothing was created.
   */
  const completeFlow = async (app: ReturnType<typeof createApp>): Promise<Response> => {
    const start = await app.request('/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'generic-oidc', callbackURL: '/' }),
    })
    const startBody = await start.clone().text()
    const { url } = (await start.json()) as { url: string }
    expect(url, `sign-in must return an authorization URL (${start.status}: ${startBody})`).toBeTruthy()

    const cookie = start.headers.get('set-cookie') ?? ''

    // The provider redirects back with a code.
    const authorized = await fetch(url, { redirect: 'manual' })
    const callback = authorized.headers.get('location')
    expect(callback, 'the provider must redirect back with a code').toBeTruthy()

    const callbackPath = callback!.replace(/^https?:\/\/[^/]+/, '')
    return app.request(callbackPath, { redirect: 'manual', headers: { cookie } })
  }

  it('WS-1 AC3: a user signs in through a generic OIDC provider discovered from its issuer', async () => {
    const app = appFor()
    const response = await completeFlow(app)

    expect(response.status, await response.clone().text()).toBeLessThan(400)

    const [user] = await db.admin.query<{ email: string; email_verified: boolean }>(
      `SELECT email, email_verified FROM users WHERE lower(email) = lower($1)`,
      [(await currentEmail()) ?? ''],
    )
    expect(user, 'an account must exist for the provider identity').toBeDefined()

    const [account] = await db.admin.query<{ provider_id: string; account_id: string }>(
      `SELECT provider_id, account_id FROM accounts WHERE account_id = $1`,
      ['provider-subject-1'],
    )
    expect(account, 'the provider credential must be recorded').toBeDefined()
    expect(account!.provider_id).not.toBe('credential')
  })

  const currentEmail = async (): Promise<string | undefined> => {
    const rows = await db.admin.query<{ email: string }>(
      `SELECT u.email FROM users u JOIN accounts a ON a.user_id = u.id
        WHERE a.account_id = 'provider-subject-1' LIMIT 1`,
    )
    return rows[0]?.email
  }

  it('WS-1 AC3: signing in twice reuses the same account rather than creating a second', async () => {
    const app = appFor()
    await completeFlow(app)

    const rows = await db.admin.query<{ count: string }>(
      `SELECT count(*) FROM accounts WHERE account_id = 'provider-subject-1'`,
    )
    expect(Number(rows[0]!.count), 'a repeat sign-in must not duplicate the credential').toBe(1)
  })

  it('WS-1 AC4: an OIDC identity does NOT link to an existing account on an unverified email', async () => {
    // A password account exists for this address.
    const email = `link-unverified-${Date.now()}@example.test`
    const app = appFor()
    await app.request('/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct-horse-battery-staple', name: 'Ada' }),
    })

    // The provider asserts the same address but does NOT vouch for it.
    oidc.setUser({
      sub: 'provider-subject-unverified',
      email,
      name: 'Impostor',
      emailVerified: false,
    })

    await completeFlow(app).catch(() => undefined)

    const linked = await db.admin.query<{ id: string }>(
      `SELECT a.id FROM accounts a
         JOIN users u ON u.id = a.user_id
        WHERE lower(u.email) = lower($1) AND a.account_id = 'provider-subject-unverified'`,
      [email],
    )
    expect(
      linked.length,
      'an unverified provider email must not take over an existing account',
    ).toBe(0)
  })

  it('WS-1 AC4: a provider-verified email links to the existing account rather than duplicating it', async () => {
    const email = `link-verified-${Date.now()}@example.test`
    const app = appFor()

    await app.request('/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct-horse-battery-staple', name: 'Ada' }),
    })
    await app.request(mailer.sent[0]!.verificationUrl!, { redirect: 'manual' })

    oidc.setUser({
      sub: 'provider-subject-verified',
      email,
      name: 'Ada Lovelace',
      emailVerified: true,
    })
    await completeFlow(app)

    const users = await db.admin.query<{ count: string }>(
      `SELECT count(*) FROM users WHERE lower(email) = lower($1)`,
      [email],
    )
    expect(Number(users[0]!.count), 'linking must not create a second user').toBe(1)

    const credentials = await db.admin.query<{ provider_id: string }>(
      `SELECT a.provider_id FROM accounts a
         JOIN users u ON u.id = a.user_id
        WHERE lower(u.email) = lower($1)`,
      [email],
    )
    expect(
      credentials.length,
      'the account should now carry both a password and a provider credential',
    ).toBe(2)
  })
})
