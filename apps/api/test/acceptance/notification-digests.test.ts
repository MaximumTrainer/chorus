import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createNotifier, type Notifier } from '@chorus/notifications'
import { createApp } from '../../src/app.js'
import {
  createRecordingMailer,
  createTestClient,
  type RecordingMailer,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * SLACK-6 AC5 — digests batch rather than flood.
 *
 * > Given many low-priority events, when digest mode is enabled, then they are
 * > batched into one message on schedule while urgent items still arrive
 * > immediately.
 *
 * The second clause is the one worth guarding. A digest that swallowed a
 * checkpoint request would turn a five-minute pause into a run stopped until
 * tomorrow morning — and it would do so quietly, to somebody who had asked for
 * fewer emails and not for slower decisions. Every test here checks both
 * halves: that the ordinary traffic batched, and that the gate did not.
 */
describe('SLACK-6 AC5 digests', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let mailer: RecordingMailer
  let notifier: Notifier

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    mailer = createRecordingMailer()
    notifier = createNotifier(db.config, { mail: mailer, baseUrl: 'http://localhost:3000' })
    client = createTestClient(createApp({ dbConfig: db.config, mailer }), mailer)
  })

  const lowPriority = (workspaceId: string, userId: string, subject: string) =>
    notifier.notify({
      workspaceId,
      recipients: [userId],
      kind: 'pull_request_opened',
      priority: 'low',
      subject,
      targetType: 'pull_request',
      path: '/somewhere',
    })

  async function withDigest(): Promise<{ ada: SignedInUser; workspaceId: string }> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Digested')

    const enabled = await ada.put(`/workspaces/${workspace.id}/notification-digest`, {
      enabled: true,
    })
    expect(enabled.status, await enabled.clone().text()).toBe(200)

    // Email is off by default for this kind, so the preference is set
    // explicitly — otherwise "nothing was sent" would be true for the wrong
    // reason and the test would prove nothing.
    await ada.put(`/workspaces/${workspace.id}/notification-preferences`, {
      kind: 'pull_request_opened',
      channel: 'email',
      enabled: true,
    })
    mailer.clear()

    return { ada, workspaceId: workspace.id }
  }

  it('SLACK-6 AC5: with digest mode on, low-priority email waits instead of arriving', async () => {
    const { ada, workspaceId } = await withDigest()

    for (const subject of ['One', 'Two', 'Three']) {
      await lowPriority(workspaceId, ada.userId, subject)
    }

    expect(mailer.to(ada.email), 'nothing may be sent before the digest runs').toHaveLength(0)
    // In-app is untouched: digest mode is about email volume, not about being
    // told at all.
    const inbox = (await (await ada.get(`/workspaces/${workspaceId}/notifications`)).json()) as {
      unread: number
    }
    expect(inbox.unread).toBe(3)
  })

  it('SLACK-6 AC5: the digest sends one message carrying all of them', async () => {
    const { ada, workspaceId } = await withDigest()
    for (const subject of ['One', 'Two', 'Three']) {
      await lowPriority(workspaceId, ada.userId, subject)
    }

    await notifier.sendDigests(workspaceId)

    const sent = mailer.to(ada.email)
    expect(sent, 'three events, one email').toHaveLength(1)
    // Naming each, because a digest that says "you have 3 notifications" makes
    // the recipient open the app to find out whether any of them matter.
    for (const subject of ['One', 'Two', 'Three']) {
      expect(sent[0]!.text).toContain(subject)
    }
  })

  it('SLACK-6 AC5: running the digest twice does not send the same items again', async () => {
    const { ada, workspaceId } = await withDigest()
    await lowPriority(workspaceId, ada.userId, 'Only once')

    await notifier.sendDigests(workspaceId)
    await notifier.sendDigests(workspaceId)

    // A scheduled job delivered twice is ordinary under at-least-once delivery,
    // and a digest is precisely the kind of message people notice repeating.
    expect(mailer.to(ada.email)).toHaveLength(1)
  })

  it('SLACK-6 AC5: an empty digest sends nothing at all', async () => {
    const { ada, workspaceId } = await withDigest()

    await notifier.sendDigests(workspaceId)

    // "You have no notifications" every morning is how a digest teaches people
    // to filter it.
    expect(mailer.to(ada.email)).toHaveLength(0)
  })

  it('SLACK-6 AC5: an urgent item arrives immediately, digest or not', async () => {
    const { ada, workspaceId } = await withDigest()

    await notifier.notify({
      workspaceId,
      recipients: [ada.userId],
      kind: 'checkpoint_requested',
      priority: 'urgent',
      subject: 'A run is waiting for your approval',
      targetType: 'checkpoint',
      path: '/somewhere',
    })

    // The clause that matters. Batching a gate would turn a five-minute pause
    // into a run stopped until tomorrow, for someone who asked for fewer
    // emails and not for slower decisions.
    expect(mailer.to(ada.email), 'a gate must not wait for a digest').toHaveLength(1)
  })

  it('SLACK-6 AC5: without digest mode, everything arrives as it happens', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Immediate')
    await ada.put(`/workspaces/${workspace.id}/notification-preferences`, {
      kind: 'pull_request_opened',
      channel: 'email',
      enabled: true,
    })
    mailer.clear()

    // Otherwise every assertion above would hold just as well against a
    // notifier that never sent anything.
    await lowPriority(workspace.id, ada.userId, 'Straight through')
    expect(mailer.to(ada.email)).toHaveLength(1)
  })

  it('SLACK-6 AC5: digest mode is a per-person choice and is reported back', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Choice')

    const off = await ada.get(`/workspaces/${workspace.id}/notification-digest`)
    expect(off.status).toBe(200)
    // Off unless asked for: batching someone's mail without them choosing it
    // is a change to when they hear about things.
    expect(await off.json()).toMatchObject({ enabled: false })

    await ada.put(`/workspaces/${workspace.id}/notification-digest`, { enabled: true })
    expect(
      await (await ada.get(`/workspaces/${workspace.id}/notification-digest`)).json(),
    ).toMatchObject({ enabled: true })
  })
})
