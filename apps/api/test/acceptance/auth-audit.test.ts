import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, type RecordingMailer } from '@chorus/testing'

/**
 * WS-1 definition of done — authentication events are auditable.
 *
 * These events happen *before* any workspace exists: a person registers, then
 * joins or creates a workspace. They therefore cannot live in the
 * workspace-scoped `audit_events` table, whose RLS policy requires a tenant.
 * They go to `auth_events`, which is identity-scoped rather than tenant-scoped.
 *
 * A failed sign-in is the single most valuable line in this log, so it is
 * asserted explicitly rather than assumed to follow from the success path.
 */
describe('WS-1 authentication audit trail', () => {
  let db: IsolatedDatabase
  let mailer: RecordingMailer
  let app: ReturnType<typeof createApp>

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

  const eventsFor = async (email: string): Promise<string[]> => {
    const rows = await db.admin.query<{ kind: string }>(
      `SELECT kind FROM auth_events WHERE lower(subject) = lower($1) ORDER BY at`,
      [email],
    )
    return rows.map((r) => r.kind)
  }

  const signUp = (email: string) =>
    app.request('/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct-horse-battery-staple', name: 'Ada' }),
    })

  const signIn = (email: string, password = 'correct-horse-battery-staple') =>
    app.request('/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })

  it('WS-1: registration is recorded', async () => {
    const email = `audit-reg-${Date.now()}@example.test`
    await signUp(email)
    expect(await eventsFor(email)).toContain('registration')
  })

  it('WS-1: verification is recorded', async () => {
    const email = `audit-ver-${Date.now()}@example.test`
    await signUp(email)
    await app.request(mailer.sent[0]!.verificationUrl!, { redirect: 'manual' })
    expect(await eventsFor(email)).toContain('email_verified')
  })

  it('WS-1: a successful sign-in is recorded', async () => {
    const email = `audit-in-${Date.now()}@example.test`
    await signUp(email)
    await app.request(mailer.sent[0]!.verificationUrl!, { redirect: 'manual' })
    await signIn(email)
    expect(await eventsFor(email)).toContain('sign_in')
  })

  it('WS-1: a FAILED sign-in is recorded — the most valuable line in the log', async () => {
    const email = `audit-fail-${Date.now()}@example.test`
    await signUp(email)
    await app.request(mailer.sent[0]!.verificationUrl!, { redirect: 'manual' })
    await signIn(email, 'wrong-password')

    const events = await eventsFor(email)
    expect(events).toContain('sign_in_failed')
    expect(events, 'a failed attempt must not be recorded as a success').not.toContain('sign_in')
  })

  it('WS-1: sign-out is recorded', async () => {
    const email = `audit-out-${Date.now()}@example.test`
    await signUp(email)
    await app.request(mailer.sent[0]!.verificationUrl!, { redirect: 'manual' })
    const signedIn = await signIn(email)
    const cookie = signedIn.headers.get('set-cookie')!
    await app.request('/auth/sign-out', { method: 'POST', headers: { cookie } })
    expect(await eventsFor(email)).toContain('sign_out')
  })

  it('WS-1: a failed sign-in for an unknown address is still recorded', async () => {
    // Otherwise credential stuffing against addresses that do not exist is
    // invisible, which is exactly the reconnaissance phase worth seeing.
    const email = `audit-unknown-${Date.now()}@example.test`
    await signIn(email, 'whatever')
    expect(await eventsFor(email)).toContain('sign_in_failed')
  })

  it('WS-1: no password or token is ever written to the audit log', async () => {
    const email = `audit-secret-${Date.now()}@example.test`
    const password = 'correct-horse-battery-staple'
    await app.request('/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Ada' }),
    })
    await signIn(email, password)

    const rows = await db.admin.query<{ everything: string }>(
      `SELECT (kind || ' ' || subject || ' ' || coalesce(detail::text, '')) AS everything
         FROM auth_events`,
    )
    for (const row of rows) {
      expect(row.everything).not.toContain(password)
    }
  })

  it('WS-1: events carry the address and the time, so a trail can be followed', async () => {
    const email = `audit-shape-${Date.now()}@example.test`
    await signUp(email)

    const [event] = await db.admin.query<{ subject: string; at: Date; kind: string }>(
      `SELECT subject, at, kind FROM auth_events WHERE lower(subject) = lower($1)`,
      [email],
    )
    expect(event!.subject.toLowerCase()).toBe(email.toLowerCase())
    expect(event!.at).toBeInstanceOf(Date)
  })
})
