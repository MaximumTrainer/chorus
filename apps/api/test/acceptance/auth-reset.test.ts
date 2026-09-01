import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, type RecordingMailer } from '@chorus/testing'

/**
 * WS-1 — password reset, and the audit events its definition of done requires.
 *
 * Reset is the highest-value target in any authentication system: it is a
 * supported path to taking over an account. So the properties asserted here are
 * the adversarial ones — no disclosure of whether an address exists, single-use
 * tokens, and old sessions not surviving a reset.
 */
describe('WS-1 password reset', () => {
  let db: IsolatedDatabase
  let mailer: RecordingMailer
  let app: ReturnType<typeof createApp>

  const ORIGINAL = 'correct-horse-battery-staple'
  const REPLACEMENT = 'a-completely-different-passphrase'

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

  /** A verified account, ready to have its password reset. */
  const verifiedAccount = async (): Promise<string> => {
    const email = `reset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`
    await app.request('/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: ORIGINAL, name: 'Ada' }),
    })
    await app.request(mailer.sent[0]!.verificationUrl!, { redirect: 'manual' })
    mailer.clear()
    return email
  }

  const requestReset = (email: string) =>
    app.request('/auth/request-password-reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, redirectTo: '/reset' }),
    })

  const signIn = (email: string, password: string) =>
    app.request('/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })

  /**
   * The reset link carries its token as a path segment (/reset-password/:token),
   * not a query parameter. Returning an empty string on a miss would make the
   * "no token in the log" assertion vacuously true, so this fails loudly.
   */
  const tokenFrom = (url: string): string => {
    const parsed = new URL(url, 'http://localhost:3000')
    const fromQuery = parsed.searchParams.get('token')
    if (fromQuery) return fromQuery

    const segments = parsed.pathname.split('/').filter(Boolean)
    const last = segments[segments.length - 1]
    if (!last || last === 'reset-password') {
      throw new Error(`no reset token found in link: ${url}`)
    }
    return last
  }

  const submitReset = (token: string, newPassword: string) =>
    app.request('/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
    })

  const eventsFor = async (email: string): Promise<string[]> => {
    const rows = await db.admin.query<{ kind: string }>(
      `SELECT kind FROM auth_events WHERE lower(subject) = lower($1) ORDER BY at`,
      [email],
    )
    return rows.map((r) => r.kind)
  }

  it('WS-1: requesting a reset sends a link to the account holder', async () => {
    const email = await verifiedAccount()
    const response = await requestReset(email)

    expect(response.status).toBeLessThan(400)
    expect(mailer.to(email)).toHaveLength(1)
    expect(mailer.to(email)[0]!.verificationUrl, 'the email must carry a reset link').toBeTruthy()
  })

  it('WS-1: a reset request for an unknown address is indistinguishable from a known one', async () => {
    // Otherwise reset becomes an oracle for which addresses hold accounts.
    const known = await verifiedAccount()
    const knownResponse = await requestReset(known)
    const unknownResponse = await requestReset(`absent-${Date.now()}@example.test`)

    expect(unknownResponse.status).toBe(knownResponse.status)
  })

  it('WS-1: the reset link sets a new password, and the old one stops working', async () => {
    const email = await verifiedAccount()
    await requestReset(email)

    const reset = await submitReset(tokenFrom(mailer.to(email)[0]!.verificationUrl!), REPLACEMENT)
    expect(reset.status, await reset.clone().text()).toBeLessThan(400)

    const withNew = await signIn(email, REPLACEMENT)
    expect(withNew.status, 'the new password must work').toBeLessThan(400)

    const withOld = await signIn(email, ORIGINAL)
    expect(withOld.status, 'the old password must not work').toBeGreaterThanOrEqual(400)
  })

  it('WS-1: a reset token is single-use', async () => {
    const email = await verifiedAccount()
    await requestReset(email)
    const token = tokenFrom(mailer.to(email)[0]!.verificationUrl!)

    await submitReset(token, REPLACEMENT)
    const replay = await submitReset(token, 'yet-another-passphrase-here')

    expect(replay.status, 'a reset token was accepted twice').toBeGreaterThanOrEqual(400)

    // The second attempt must not have taken effect either.
    const withReplayed = await signIn(email, 'yet-another-passphrase-here')
    expect(withReplayed.status).toBeGreaterThanOrEqual(400)
  })

  it('WS-1: reset requests and completions are both audited', async () => {
    const email = await verifiedAccount()
    await requestReset(email)
    await submitReset(tokenFrom(mailer.to(email)[0]!.verificationUrl!), REPLACEMENT)

    const events = await eventsFor(email)
    expect(events).toContain('password_reset_requested')
    expect(events).toContain('password_reset')
  })

  it('WS-1: no reset token or password is written to the audit log', async () => {
    const email = await verifiedAccount()
    await requestReset(email)
    const token = tokenFrom(mailer.to(email)[0]!.verificationUrl!)
    await submitReset(token, REPLACEMENT)

    const rows = await db.admin.query<{ everything: string }>(
      `SELECT (kind || ' ' || subject || ' ' || coalesce(detail::text, '')) AS everything
         FROM auth_events`,
    )
    for (const row of rows) {
      expect(row.everything).not.toContain(token)
      expect(row.everything).not.toContain(REPLACEMENT)
    }
  })
})

/**
 * WS-1 AC5 — throttling is itself an auditable event. A lockout nobody can see
 * is a lockout nobody can investigate.
 */
describe('WS-1 AC5 lockout is audited', () => {
  let db: IsolatedDatabase

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('WS-1 AC5: a throttled attempt is recorded as rate_limited', async () => {
    const mailer = createRecordingMailer()
    const app = createApp({ dbConfig: db.config, mailer, maxSignInAttempts: 2 })
    const email = `lockout-${Date.now()}@example.test`

    await app.request('/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct-horse-battery-staple', name: 'Ada' }),
    })
    await app.request(mailer.sent[0]!.verificationUrl!, { redirect: 'manual' })

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.request('/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'wrong-password' }),
      })
      if (response.status === 429) break
    }

    const rows = await db.admin.query<{ kind: string }>(
      `SELECT kind FROM auth_events WHERE lower(subject) = lower($1)`,
      [email],
    )
    expect(rows.map((r) => r.kind)).toContain('rate_limited')
  })
})
