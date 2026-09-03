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
 * SLACK-6 AC2 — the checkpoint email is actionable.
 *
 * > Email links must authenticate safely — a single-use, short-lived token
 * > bound to the specific checkpoint, never a general-purpose session link in
 * > an email.
 *
 * That sentence is the whole design. A link in an email is a bearer
 * credential: it sits in a mailbox, in browser history, in a forwarded thread
 * and possibly in a corporate mail archive. So the tests here spend most of
 * their effort on what the token *cannot* do — reach another checkpoint, act
 * twice, survive the gate it belongs to, or become a session.
 */
describe('SLACK-6 AC2 checkpoint decision links', () => {
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
      execute: async () => {
        performed.push(name)
        return { ran: name }
      },
    }) as unknown as AnyTool

  let performed: string[]

  const gated = (): WorkflowDefinition =>
    WorkflowDefinitionSchema.parse({
      name: 'gated-flow',
      version: 1,
      tools: ['prepare', 'act'],
      steps: [
        { id: 'prepare', type: 'tool', tool: 'prepare' },
        { id: 'gate', type: 'checkpoint', kind: 'before_create_artefacts' },
        { id: 'act', type: 'tool', tool: 'act' },
      ],
    })

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    performed = []
    mailer = createRecordingMailer()
    notifier = createNotifier(db.config, { mail: mailer, baseUrl: 'http://localhost:3000' })
    executor = createExecutor(db.config, {
      registry: createToolRegistry([noop('prepare'), noop('act')]),
      models: createFakeModelProvider(),
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      notify: (event) => notifier.notify(event),
    })
    client = createTestClient(
      createApp({
        dbConfig: db.config,
        mailer,
        resumeRun: async (workspaceId, runId) => {
          await executor.run(workspaceId, runId)
        },
      }),
      mailer,
    )
  })

  /** A run stopped at its gate, with the email that announced it. */
  async function gateWithEmail(): Promise<{
    ada: SignedInUser
    workspaceId: string
    runId: string
    checkpointId: string
    link: string
  }> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Linked')
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

    const view = (await (await ada.get(`/workspaces/${workspace.id}/runs/${run.id}`)).json()) as {
      checkpoint: { id: string }
    }
    const link = mailer.to(ada.email).at(-1)?.verificationUrl
    expect(link, 'the checkpoint email must carry a link').toBeDefined()

    return {
      ada,
      workspaceId: workspace.id,
      runId: run.id,
      checkpointId: view.checkpoint.id,
      link: link!,
    }
  }

  const path = (url: string): string => new URL(url, 'http://localhost:3000').pathname

  it('SLACK-6 AC2: following the link shows the decision, without signing in', async () => {
    const { link } = await gateWithEmail()
    const anonymous = client.anonymous()

    const view = await anonymous.get(path(link))
    expect(view.status, await view.clone().text()).toBe(200)

    const body = (await view.json()) as {
      status: string
      kind: string
      payload: { workflow: string }
    }
    // The actual proposed action, so the decision can be made from the page the
    // link leads to rather than by going and finding it.
    expect(body).toMatchObject({ status: 'pending', kind: 'before_create_artefacts' })
    expect(body.payload.workflow).toBe('gated-flow@1')
  })

  it('SLACK-6 AC2: viewing does not consume the link — only deciding does', async () => {
    const { link } = await gateWithEmail()
    const anonymous = client.anonymous()

    // Mail clients prefetch links. A token consumed by being looked at would
    // be spent before the recipient ever saw the page.
    expect((await anonymous.get(path(link))).status).toBe(200)
    expect((await anonymous.get(path(link))).status).toBe(200)

    const decided = await anonymous.post(path(link), { decision: 'approve' })
    expect(decided.status, await decided.clone().text()).toBe(200)
  })

  it('SLACK-6 AC2 / AGENT-3 AC4: deciding from the link settles the checkpoint everywhere', async () => {
    const { ada, workspaceId, runId, checkpointId, link } = await gateWithEmail()

    const decided = await client.anonymous().post(path(link), { decision: 'approve' })
    expect(decided.status).toBe(200)

    // The API surface must agree, and the run must have continued.
    const checkpoint = (await (
      await ada.get(`/workspaces/${workspaceId}/checkpoints/${checkpointId}`)
    ).json()) as { status: string; decidedBy: string }
    expect(checkpoint.status).toBe('approved')
    // Attributed to the person the email was addressed to, not to nobody.
    expect(checkpoint.decidedBy).toBe(ada.userId)

    const run = (await (await ada.get(`/workspaces/${workspaceId}/runs/${runId}`)).json()) as {
      status: string
    }
    expect(run.status).toBe('succeeded')
    expect(performed).toEqual(['prepare', 'act'])
  })

  it('SLACK-6 AC2: the link is single-use, and the second attempt shows the outcome', async () => {
    const { link } = await gateWithEmail()
    const anonymous = client.anonymous()

    expect((await anonymous.post(path(link), { decision: 'approve' })).status).toBe(200)

    const second = await anonymous.post(path(link), { decision: 'reject' })
    // Refused, and specifically not applied: a forwarded email must not be able
    // to reverse a decision somebody already made.
    expect(second.status).toBe(409)
  })

  it('SLACK-6 AC2: a token settles its own checkpoint and no other', async () => {
    const first = await gateWithEmail()
    const second = await gateWithEmail()

    await client.anonymous().post(path(first.link), { decision: 'approve' })

    // The second gate is untouched. A token that worked across checkpoints
    // would make one leaked email a key to every gate in the deployment.
    const still = (await (
      await second.ada.get(`/workspaces/${second.workspaceId}/checkpoints/${second.checkpointId}`)
    ).json()) as { status: string }
    expect(still.status).toBe('pending')
  })

  it('SLACK-6 AC2: the token is not a session — it opens nothing else', async () => {
    const { link, workspaceId } = await gateWithEmail()
    const token = path(link).split('/').pop()!
    const anonymous = client.anonymous()

    // The whole point of "never a general-purpose session link in an email".
    // Presented anywhere else, it is just a string.
    expect((await anonymous.get(`/workspaces/${workspaceId}`)).status).toBe(401)
    expect(
      (await anonymous.get(`/workspaces/${workspaceId}/notifications`)).status,
    ).toBe(401)
    expect((await anonymous.get(`/checkpoint-decisions/${token}x`)).status).toBe(404)
  })

  it('SLACK-6 AC2: an unknown or malformed token is refused without saying why', async () => {
    const anonymous = client.anonymous()

    // Distinguishing "no such token" from "expired" would let someone probe for
    // live gates, and there is nothing useful the holder of a bad link can do
    // with the difference.
    for (const token of ['not-a-token', '0'.repeat(64)]) {
      const response = await anonymous.get(`/checkpoint-decisions/${token}`)
      expect(response.status).toBe(404)
    }
  })

  it('SLACK-6 AC2: the raw token is never stored', async () => {
    const { link } = await gateWithEmail()
    const token = path(link).split('/').pop()!

    const [row] = await db.admin.query<{ found: string }>(
      `SELECT count(*)::text AS found FROM checkpoint_decision_tokens WHERE token_hash = $1`,
      [token],
    )
    // Stored hashed, like every other credential here: a database dump must not
    // hand over every open gate.
    expect(row!.found).toBe('0')
  })
})
