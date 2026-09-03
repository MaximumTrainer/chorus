import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import type { MailTransport } from '@chorus/core'
import { createNotifier, type Notifier } from '@chorus/notifications'
import { createApp } from '../../src/app.js'
import {
  createRecordingMailer,
  createTestClient,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * SLACK-6 AC6 — a failing mail transport is visible, not silent.
 *
 * > Given a failing mail transport, when delivery fails, then it is retried
 * > with backoff, the failure is visible to admins, and the in-app notification
 * > is unaffected.
 *
 * The last clause is the one that matters most for a self-hosted deployment,
 * because a misconfigured SMTP host is its ordinary first state. If a broken
 * transport could swallow a checkpoint notification, the inbox — the only
 * surface such a deployment has — would be empty and the run would wait
 * forever. So these tests break the transport on purpose.
 *
 * The retry *mechanism* is asserted where it lives: in the notifier's
 * integration tests, and in the worker's, which run a real queue. What is
 * asserted here is what an operator can actually see.
 */
describe('SLACK-6 AC6 delivery failures', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let notifier: Notifier

  const broken: MailTransport = {
    send: async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:25')
    },
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    notifier = createNotifier(db.config, { mail: broken, baseUrl: 'http://localhost:3000' })
    client = createTestClient(createApp({ dbConfig: db.config, mailer }), mailer)
  })

  async function failedDelivery(): Promise<{ ada: SignedInUser; workspaceId: string }> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Broken Mail')

    await notifier.notify({
      workspaceId: workspace.id,
      recipients: [ada.userId],
      kind: 'checkpoint_requested',
      subject: 'A run is waiting for your approval',
      targetType: 'checkpoint',
      targetId: workspace.id,
      path: '/somewhere',
    })

    return { ada, workspaceId: workspace.id }
  }

  it('SLACK-6 AC6: the in-app notification survives a transport that cannot send', async () => {
    const { ada, workspaceId } = await failedDelivery()

    const inbox = (await (await ada.get(`/workspaces/${workspaceId}/notifications`)).json()) as {
      unread: number
    }
    // The whole requirement in one assertion: with no chat surface and no
    // working mail, the inbox is what remains, and it must still fill.
    expect(inbox.unread).toBe(1)
  })

  it('SLACK-6 AC6: an admin can see what failed and why', async () => {
    const { ada, workspaceId } = await failedDelivery()

    const response = await ada.get(`/workspaces/${workspaceId}/notification-deliveries`)
    expect(response.status, await response.clone().text()).toBe(200)

    const failures = (await response.json()) as Array<{
      channel: string
      status: string
      attempts: number
      lastError: string
      kind: string
      subject: string
    }>
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ channel: 'email', status: 'failed', attempts: 1 })
    // Specific, not "delivery failed": a message without the reason sends an
    // operator to the logs of a process that may no longer exist.
    expect(failures[0]!.lastError).toContain('ECONNREFUSED')
    // And enough context to know what was lost, rather than an opaque id.
    expect(failures[0]!.kind).toBe('checkpoint_requested')
  })

  it('SLACK-6 AC6: a healthy deployment shows an empty list, not a missing endpoint', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Healthy')

    // Otherwise "nothing has failed" and "the check is broken" look identical
    // to whoever is on call.
    const response = await ada.get(`/workspaces/${workspace.id}/notification-deliveries`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  it('SLACK-6 AC6: delivery failures are an operator’s view, not a member’s', async () => {
    const { ada, workspaceId } = await failedDelivery()
    const bob = await client.memberWithRole(ada, workspaceId, 'member')

    // The list spans everyone's notifications, including their subjects. That
    // is an administrative view of other people's mail, so it takes an
    // administrative role.
    expect((await bob.get(`/workspaces/${workspaceId}/notification-deliveries`)).status).toBe(403)
  })
})
