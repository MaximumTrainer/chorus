import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import {
  createRecordingMailer,
  createTestClient,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * CHAT-5 — the confirmation gate.
 *
 * > This single behaviour is the product's spine. It is what separates a
 * > workspace that respects the user's judgement from one that floods their
 * > tracker with generated tickets. The guarantee that nothing is written
 * > before confirmation must be **structural** — enforced by the data model —
 * > and not merely a UI convention.
 *
 * "Structural" is why AC1 is asserted by querying tasks directly rather than by
 * checking that no button was pressed. A UI convention passes a test that asks
 * the UI; only the data model passes a test that asks the table.
 */
describe('CHAT-5 structure proposals', () => {
  let db: IsolatedDatabase
  let client: TestClient

  interface World {
    ada: SignedInUser
    workspaceId: string
    teamId: string
    sessionId: string
  }

  const tree = {
    nodes: [
      {
        key: 'root',
        title: 'Split the invoice parser',
        summary: 'It does three jobs.',
        type: 'epic',
        tags: ['billing'],
        size: 'L',
        children: [
          {
            key: 'parse',
            title: 'Extract parsing',
            summary: 'Pull the parse step out.',
            type: 'task',
            tags: ['billing'],
            size: 'M',
            children: [],
          },
          {
            key: 'validate',
            title: 'Extract validation',
            summary: 'Pull the validation step out.',
            type: 'task',
            tags: [],
            size: 'S',
            children: [],
          },
        ],
      },
    ],
  }

  async function world(): Promise<World> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Delivery')
    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    const started = (await (
      await ada.post(`/workspaces/${workspace.id}/teams/${teams[0]!.id}/sessions`, {
        entryPoint: 'idea',
        seed: 'The invoice parser does too much',
      })
    ).json()) as { id: string }

    return { ada, workspaceId: workspace.id, teamId: teams[0]!.id, sessionId: started.id }
  }

  /** A proposal in `proposed` state, as a run would leave one. */
  async function proposed(w: World): Promise<string> {
    const created = await w.ada.post(
      `/workspaces/${w.workspaceId}/sessions/${w.sessionId}/proposals`,
      { tree },
    )
    expect(created.status, await created.clone().text()).toBe(201)
    return ((await created.json()) as { id: string }).id
  }

  const tasksIn = async (w: World): Promise<Array<{ title: string; parentId: string | null }>> =>
    (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`)
    ).json()) as Array<{ title: string; parentId: string | null }>

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    client = createTestClient(createApp({ dbConfig: db.config, mailer }), mailer)
  })

  it('CHAT-5 AC1: a proposed tree creates no task until it is confirmed', async () => {
    // Given a proposal in `proposed` state
    const w = await world()
    const proposalId = await proposed(w)

    // When the tasks are queried by any means
    // Then none from that proposal exists. Asked of the table, not of the
    // screen: a UI that merely declines to show them would pass any test that
    // asks the UI, and this is the guarantee the product is built on.
    expect(await tasksIn(w)).toEqual([])
    const [row] = await db.admin.query<{ count: string }>(
      `SELECT count(*) FROM tasks WHERE workspace_id = $1`,
      [w.workspaceId],
    )
    expect(Number(row!.count)).toBe(0)

    const read = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/proposals/${proposalId}`)
    ).json()) as { status: string }
    expect(read.status).toBe('proposed')
  })

  it('CHAT-5 AC2: confirming materialises the tree faithfully, and all at once', async () => {
    // Given a proposal with nested nodes
    const w = await world()
    const proposalId = await proposed(w)

    // When it is confirmed
    const confirmed = await w.ada.post(
      `/workspaces/${w.workspaceId}/proposals/${proposalId}/confirm`,
      {},
    )
    expect(confirmed.status, await confirmed.clone().text()).toBe(200)

    // Then the hierarchy, tags, summaries and sizes survive
    const tasks = await tasksIn(w)
    expect(tasks).toHaveLength(3)

    const root = tasks.find((task) => task.title === 'Split the invoice parser')!
    const parse = tasks.find((task) => task.title === 'Extract parsing')!
    const validate = tasks.find((task) => task.title === 'Extract validation')!
    expect(root.parentId).toBeNull()
    expect(parse.parentId).toBe((root as unknown as { id: string }).id)
    expect(validate.parentId).toBe((root as unknown as { id: string }).id)

    const detail = (await (
      await w.ada.get(
        `/workspaces/${w.workspaceId}/tasks/${(parse as unknown as { id: string }).id}`,
      )
    ).json()) as { tags: string[]; size: string | null }
    expect(detail.tags).toEqual(['billing'])
    expect(detail.size).toBe('M')

    const read = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/proposals/${proposalId}`)
    ).json()) as { status: string }
    expect(read.status).toBe('confirmed')
  })

  it('CHAT-5 AC5: confirming twice creates one set of tasks and returns the same result', async () => {
    // Given a confirmed proposal
    const w = await world()
    const proposalId = await proposed(w)
    const first = await w.ada.post(
      `/workspaces/${w.workspaceId}/proposals/${proposalId}/confirm`,
      {},
    )
    const firstBody = (await first.json()) as { taskIds: string[] }

    // When confirmation is submitted again
    const second = await w.ada.post(
      `/workspaces/${w.workspaceId}/proposals/${proposalId}/confirm`,
      {},
    )

    // Then the second returns the existing result rather than a second tree.
    // A retried request is the ordinary case, not the exotic one: a dropped
    // response and a refresh both look exactly like this.
    expect(second.status).toBe(200)
    expect(((await second.json()) as { taskIds: string[] }).taskIds).toEqual(firstBody.taskIds)
    expect(await tasksIn(w)).toHaveLength(3)
  })

  it('CHAT-5 AC2: a tree that cannot be created in full creates nothing at all', async () => {
    // Given a proposal whose *second* node cannot become a task — a size the
    // task model does not have. It survives proposal validation, because the
    // set of sizes is the database's to enforce, and fails at insert.
    const w = await world()
    const created = await w.ada.post(
      `/workspaces/${w.workspaceId}/sessions/${w.sessionId}/proposals`,
      {
        tree: {
          nodes: [
            { key: 'a', title: 'Valid enough', tags: [], children: [] },
            { key: 'b', title: 'Impossible size', size: 'ENORMOUS', tags: [], children: [] },
          ],
        },
      },
    )
    expect(created.status, await created.clone().text()).toBe(201)
    const proposalId = ((await created.json()) as { id: string }).id

    // When it is confirmed
    const confirmed = await w.ada.post(
      `/workspaces/${w.workspaceId}/proposals/${proposalId}/confirm`,
      {},
    )
    expect(confirmed.status, 'materialisation should have failed').toBeGreaterThanOrEqual(400)

    // Then nothing is created — not even the first node, which was fine on its
    // own. "All or nothing" is the whole of AC2's second half: half a task tree
    // is worse than none, because somebody has to work out which half is
    // missing, and the tree is the only place that says.
    expect(await tasksIn(w)).toEqual([])

    // and the proposal is still open, so it can be fixed and confirmed rather
    // than being left in a state nobody can act on.
    const read = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/proposals/${proposalId}`)
    ).json()) as { status: string }
    expect(read.status).toBe('proposed')
  })

  it('CHAT-5 AC4: rejection records the feedback and creates nothing', async () => {
    // Given a proposal
    const w = await world()
    const proposalId = await proposed(w)

    // When it is rejected with feedback
    const rejected = await w.ada.post(
      `/workspaces/${w.workspaceId}/proposals/${proposalId}/reject`,
      { feedback: 'Too granular — one task per service, not per function.' },
    )
    expect(rejected.status, await rejected.clone().text()).toBe(200)

    // Then no tasks exist and the feedback is kept where the next turn can read it
    expect(await tasksIn(w)).toEqual([])
    const read = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/proposals/${proposalId}`)
    ).json()) as { status: string; feedback: string | null }
    expect(read.status).toBe('rejected')
    expect(read.feedback).toContain('one task per service')
  })
})
