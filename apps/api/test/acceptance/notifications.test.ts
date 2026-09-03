import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { z } from 'zod'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { WorkflowDefinitionSchema, type AnyTool, type WorkflowDefinition } from '@chorus/core'
import { createExecutor, createToolRegistry, type Executor } from '@chorus/agent'
import { createNotifier, type Notifier } from '@chorus/notifications'
import { createApp } from '../../src/app.js'
import {
  createFakeModelProvider,
  createRecordingMailer,
  createTestClient,
  type RecordingMailer,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * SLACK-6 — notifications with no chat surface connected.
 *
 * > Checkpoints are useless if nobody sees them, and a self-hosted deployment
 * > may connect no chat surface at all.
 *
 * That is the whole requirement, and it is why this suite connects nothing.
 * The event driven throughout is an `ask` checkpoint, because it is the one
 * AGENT-3 depends on and the one where silence is not an inconvenience but a
 * run stopped forever with nobody aware.
 *
 * Deliberately not asserted here, and tracked as the next slices: the
 * single-use decision link (AC2), the live in-app badge across tabs (AC4,
 * which needs a web app that does not exist yet), digest batching (AC5) and
 * transport retry (AC6).
 */
describe('SLACK-6 notifications', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let mailer: RecordingMailer
  let executor: Executor
  let notifier: Notifier

  const noop = (name: string): AnyTool =>
    ({
      name,
      description: name,
      input: z.object({}).passthrough(),
      output: z.object({}).passthrough(),
      sideEffect: 'none',
      requiredRole: 'member',
      requiredScopes: [],
      execute: async () => ({ ran: name }),
    }) as unknown as AnyTool

  const gated = (): WorkflowDefinition =>
    WorkflowDefinitionSchema.parse({
      name: 'gated-flow',
      version: 1,
      tools: ['prepare'],
      steps: [
        { id: 'prepare', type: 'tool', tool: 'prepare' },
        { id: 'gate', type: 'checkpoint', kind: 'before_create_artefacts' },
      ],
    })

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    mailer = createRecordingMailer()
    notifier = createNotifier(db.config, { mail: mailer, baseUrl: 'http://localhost:3000' })
    executor = createExecutor(db.config, {
      registry: createToolRegistry([noop('prepare')]),
      models: createFakeModelProvider(),
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      notify: (event) => notifier.notify(event),
    })
    client = createTestClient(createApp({ dbConfig: db.config, mailer }), mailer)
  })

  async function reachTheGate(): Promise<{
    ada: SignedInUser
    workspaceId: string
    runId: string
  }> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Notified')
    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>

    const run = await executor.start({
      workspaceId: workspace.id,
      teamId: teams[0]!.id,
      startedBy: ada.userId,
      definition: gated(),
      input: {},
    })
    await executor.run(workspace.id, run.id)
    return { ada, workspaceId: workspace.id, runId: run.id }
  }

  const inbox = async (
    ada: SignedInUser,
    workspaceId: string,
  ): Promise<{
    unread: number
    notifications: Array<{
      id: string
      kind: string
      subject: string
      targetType: string
      targetId: string
      readAt: string | null
    }>
  }> => {
    const response = await ada.get(`/workspaces/${workspaceId}/notifications`)
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json() as never
  }

  it('SLACK-6 AC1: a checkpoint reaches its recipient in-app with no chat surface connected', async () => {
    const { ada, workspaceId, runId } = await reachTheGate()

    const { unread, notifications } = await inbox(ada, workspaceId)
    expect(unread).toBe(1)
    expect(notifications[0]).toMatchObject({
      kind: 'checkpoint_requested',
      // Pointing at the thing to act on, not merely announcing that something
      // happened — a notification you cannot act from is a distraction.
      targetType: 'checkpoint',
      readAt: null,
    })
    expect(notifications[0]!.subject).toContain('gated-flow')

    const run = (await (await ada.get(`/workspaces/${workspaceId}/runs/${runId}`)).json()) as {
      checkpoint: { id: string }
    }
    expect(notifications[0]!.targetId).toBe(run.checkpoint.id)
  })

  it('SLACK-6 AC1: and by email, because a stopped run nobody sees is stopped forever', async () => {
    const { ada } = await reachTheGate()

    const sent = mailer.to(ada.email)
    expect(sent.length, 'the default for a gating notification is to send').toBeGreaterThan(0)
    expect(sent.at(-1)!.subject).toMatch(/approval|checkpoint|waiting/i)
    // The recipient must be able to get there. A mail that says "something
    // needs you" and offers no way to reach it is worse than none.
    expect(sent.at(-1)!.verificationUrl, 'the email must carry a link').toBeDefined()
  })

  it('SLACK-6 AC4: reading a notification clears it from the unread count', async () => {
    const { ada, workspaceId } = await reachTheGate()
    const { notifications } = await inbox(ada, workspaceId)

    const read = await ada.post(
      `/workspaces/${workspaceId}/notifications/${notifications[0]!.id}/read`,
    )
    expect(read.status).toBe(200)

    const after = await inbox(ada, workspaceId)
    expect(after.unread).toBe(0)
    expect(after.notifications[0]!.readAt).not.toBeNull()

    // Reading twice must not drive the count negative or re-stamp the time.
    await ada.post(`/workspaces/${workspaceId}/notifications/${notifications[0]!.id}/read`)
    const again = await inbox(ada, workspaceId)
    expect(again.unread).toBe(0)
    expect(again.notifications[0]!.readAt).toBe(after.notifications[0]!.readAt)
  })

  it('SLACK-6 AC3: disabling email for a kind stops the email and keeps the in-app', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Preferences')

    const set = await ada.put(`/workspaces/${workspace.id}/notification-preferences`, {
      kind: 'checkpoint_requested',
      channel: 'email',
      enabled: false,
    })
    expect(set.status, await set.clone().text()).toBe(200)
    mailer.clear()

    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    const run = await executor.start({
      workspaceId: workspace.id,
      teamId: teams[0]!.id,
      startedBy: ada.userId,
      definition: gated(),
      input: {},
    })
    await executor.run(workspace.id, run.id)

    expect(mailer.to(ada.email), 'email was switched off for this kind').toHaveLength(0)
    // Exactly: the choice was about a channel, not about being told at all.
    expect((await inbox(ada, workspace.id)).unread).toBe(1)
  })

  it('SLACK-6: a gating notification cannot be silenced on every channel', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Cannot Silence')

    // "Unsubscribe must not be able to silence checkpoint requests entirely;
    // offer channel choice rather than complete opt-out." A run waiting on a
    // person who has muted the only way of telling them waits forever.
    const refused = await ada.put(`/workspaces/${workspace.id}/notification-preferences`, {
      kind: 'checkpoint_requested',
      channel: 'in_app',
      enabled: false,
    })
    expect(refused.status).toBe(400)
    expect(await refused.text()).toMatch(/cannot be turned off|required/i)
  })

  it('SLACK-6: preferences for a non-gating kind may be turned off on every channel', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Quiet')

    // Otherwise the rule above would be indistinguishable from "preferences do
    // not work", and every kind would be effectively mandatory.
    for (const channel of ['in_app', 'email']) {
      const response = await ada.put(`/workspaces/${workspace.id}/notification-preferences`, {
        kind: 'job_status',
        channel,
        enabled: false,
      })
      expect(response.status, await response.clone().text()).toBe(200)
    }
  })

  it("SLACK-6: one member's inbox is not another's", async () => {
    const { ada, workspaceId } = await reachTheGate()
    const bob = await client.memberWithRole(ada, workspaceId, 'member')

    // The gate belongs to Ada's run. Bob is a member of the workspace and can
    // see the run, but the notification was addressed to a person.
    expect((await inbox(bob, workspaceId)).unread).toBe(0)
    expect((await inbox(ada, workspaceId)).unread).toBe(1)
  })
})
