import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, type RecordingMailer } from '@chorus/testing'
import type { createApp as CreateApp } from '../../src/app.js'

/**
 * WS-1 — sign-up and sign-in with email and password.
 *
 * Asserted against *behaviour*, not mechanism (ADR-0011): verification before
 * sign-in, single-use expiring tokens, bounded failed attempts, immediate
 * revocation. These tests stay valid if the auth library is ever replaced.
 */
describe('WS-1 email and password authentication', () => {
  let db: IsolatedDatabase
  let mailer: RecordingMailer
  let app: ReturnType<typeof CreateApp>

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    mailer = createRecordingMailer()
    app = createApp({ dbConfig: db.config, mailer })
  })

  const signUp = (email: string, password = 'correct-horse-battery-staple') =>
    app.request('/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Ada Lovelace' }),
    })

  const signIn = (email: string, password = 'correct-horse-battery-staple') =>
    app.request('/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })

  it('WS-1 AC1: signing up sends a verification email and creates an unverified account', async () => {
    const email = `ac1-${Date.now()}@example.test`
    const response = await signUp(email)

    expect(response.status, await response.clone().text()).toBeLessThan(400)

    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]!.to).toBe(email)
    expect(mailer.sent[0]!.verificationUrl, 'the email must carry a verification link').toBeTruthy()

    const [user] = await db.admin.query<{ email_verified: boolean }>(
      `SELECT email_verified FROM users WHERE lower(email) = lower($1)`,
      [email],
    )
    expect(user, 'the account must exist').toBeDefined()
    expect(user!.email_verified, 'the account must start unverified').toBe(false)
  })

  it('WS-1 AC1: signing in before verification is refused, distinguishably', async () => {
    const email = `ac1b-${Date.now()}@example.test`
    await signUp(email)

    const response = await signIn(email)
    expect(response.status).toBeGreaterThanOrEqual(400)

    const body = await response.text()
    expect(
      /verif/i.test(body),
      `the refusal must say verification is the reason, got: ${body}`,
    ).toBe(true)
  })

  it('WS-1 AC2: presenting the verification token verifies the account and permits sign-in', async () => {
    const email = `ac2-${Date.now()}@example.test`
    await signUp(email)

    const verify = await app.request(mailer.sent[0]!.verificationUrl!, { redirect: 'manual' })
    expect(verify.status).toBeLessThan(400)

    const [user] = await db.admin.query<{ email_verified: boolean }>(
      `SELECT email_verified FROM users WHERE lower(email) = lower($1)`,
      [email],
    )
    expect(user!.email_verified).toBe(true)

    const response = await signIn(email)
    expect(response.status, await response.clone().text()).toBeLessThan(400)
  })

  it('WS-1 AC2: a verification token is single-use', async () => {
    const email = `ac2b-${Date.now()}@example.test`
    await signUp(email)
    const url = mailer.sent[0]!.verificationUrl!

    await app.request(url, { redirect: 'manual' })
    const second = await app.request(url, { redirect: 'manual' })

    // Either refused outright, or redirected to an error - never silently
    // accepted a second time.
    const location = second.headers.get('location') ?? ''
    const replayed = second.status < 400 && !/error/i.test(location)
    expect(replayed, 'a verification token was accepted twice').toBe(false)
  })

  it('WS-1 AC5: repeated wrong passwords are eventually refused with a retry-after', async () => {
    // A dedicated app with a low bound: the throttle is the behaviour under
    // test here, and must not bleed into unrelated cases.
    app = createApp({ dbConfig: db.config, mailer, maxSignInAttempts: 3 })

    const email = `ac5-${Date.now()}@example.test`
    await signUp(email)
    await app.request(mailer.sent[0]!.verificationUrl!, { redirect: 'manual' })

    let throttled: Response | undefined
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const response = await signIn(email, 'wrong-password')
      if (response.status === 429) {
        throttled = response
        break
      }
    }

    expect(throttled, 'repeated failures were never throttled').toBeDefined()
    expect(
      throttled!.headers.get('x-retry-after') ?? throttled!.headers.get('retry-after'),
      'a throttled response must say when to retry',
    ).toBeTruthy()
  })

  it('WS-1 AC5: a wrong password never reveals whether the account exists', async () => {
    const existing = `ac5b-${Date.now()}@example.test`
    await signUp(existing)

    const wrongPassword = await signIn(existing, 'wrong-password')
    const noSuchUser = await signIn(`absent-${Date.now()}@example.test`, 'wrong-password')

    expect(wrongPassword.status).toBe(noSuchUser.status)
  })

  it('WS-1 AC6: a session is revoked immediately on sign-out', async () => {
    const email = `ac6-${Date.now()}@example.test`
    await signUp(email)
    await app.request(mailer.sent[0]!.verificationUrl!, { redirect: 'manual' })

    const signedIn = await signIn(email)
    const cookie = signedIn.headers.get('set-cookie')
    expect(cookie, 'signing in must issue a session cookie').toBeTruthy()

    const before = await app.request('/auth/get-session', { headers: { cookie: cookie! } })
    expect(await before.json()).toBeTruthy()

    await app.request('/auth/sign-out', { method: 'POST', headers: { cookie: cookie! } })

    const after = await app.request('/auth/get-session', { headers: { cookie: cookie! } })
    const session = await after.json()
    expect(session, 'the session survived sign-out').toBeFalsy()
  })

  it('WS-1: the password hash is never stored in a readable form', async () => {
    const email = `hash-${Date.now()}@example.test`
    const password = 'correct-horse-battery-staple'
    await signUp(email, password)

    const rows = await db.admin.query<{ password: string | null }>(
      `SELECT a.password FROM accounts a
         JOIN users u ON u.id = a.user_id
        WHERE lower(u.email) = lower($1)`,
      [email],
    )
    const stored = rows.map((r) => r.password).filter(Boolean)
    expect(stored.length, 'a credential row must exist').toBeGreaterThan(0)
    for (const hash of stored) {
      expect(hash).not.toContain(password)
      expect(hash!.length).toBeGreaterThan(40)
    }
  })
})
