import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ulid } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRetriever } from '@chorus/brain'
import { createDecomposer } from '../../src/decompose.js'
import {
  createFakeModelProvider,
  createRecordingMailer,
  createTestClient,
  type FakeModelProvider,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * DOC-6 — the hinge between Shape and Deliver, and CHAT-5 AC6, the gate that
 * a team may decide it does not want.
 *
 * These are one piece of work because they are one mechanism: a proposal
 * produced by a *run*, and a policy that decides whether a person sees it
 * before it becomes tasks. Built separately they would have disagreed about
 * where the gate lives, which is the sort of disagreement that is only
 * discovered by a team who turned `auto` on and got nothing.
 */
describe('DOC-6 decomposition', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let models: FakeModelProvider

  interface World {
    ada: SignedInUser
    workspaceId: string
    teamId: string
    documentId: string
  }

  /** What the model is scripted to propose, in the shape the prompt asks for. */
  const proposal = {
    nodes: [
      {
        key: 'billing',
        title: 'Split the invoice parser',
        summary: 'The parser does three jobs.',
        size: 'L',
        tags: ['billing'],
        sectionKeys: ['requirements'],
        children: [
          {
            key: 'parse',
            title: 'Extract parsing',
            summary: 'Pull the parse step out.',
            size: 'M',
            tags: ['billing'],
            sectionKeys: ['requirements'],
            acceptanceCriteria: ['A malformed invoice is rejected with a reason'],
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
    const teamId = teams[0]!.id

    const document = (await (
      await ada.post(`/workspaces/${workspace.id}/teams/${teamId}/documents`, {
        type: 'prd',
        title: 'Invoice splitting',
      })
    ).json()) as { id: string }

    return { ada, workspaceId: workspace.id, teamId, documentId: document.id }
  }

  /** A team that has decided it does not want to be asked (CHAT-5 AC6). */
  async function policyIsAuto(w: World): Promise<void> {
    await db.admin.execute(
      `INSERT INTO policies (id, workspace_id, team_id, checkpoint_kind, mode)
       VALUES ($1, $2, $3, 'before_create_artefacts', 'auto')`,
      [ulid(), w.workspaceId, w.teamId],
    )
  }

  const tasksIn = async (w: World): Promise<Array<{ id: string; title: string }>> =>
    (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`)
    ).json()) as Array<{ id: string; title: string }>

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    models = createFakeModelProvider()
    client = createTestClient(
      createApp({
        dbConfig: db.config,
        mailer,
        decompose: createDecomposer(db.config, {
          models,
          modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
          // The workflow grounds its proposal in the codebase, and the runtime
          // refuses to retrieve nothing and call it an empty result — so a
          // decomposer without a retriever is a misconfiguration, not a
          // degraded mode.
          retriever: createRetriever(db.config, {
            models,
            embeddingModel: { provider: 'fake', model: 'fake-embed' },
          }),
        }),
      }),
      mailer,
    )
  })

  it('DOC-6 AC1: decomposing a document proposes a tree, and creates no task', async () => {
    // Given a PRD
    const w = await world()
    models.script({ chunks: [JSON.stringify(proposal)] })

    // When decomposition runs
    const response = await w.ada.post(
      `/workspaces/${w.workspaceId}/documents/${w.documentId}/decompose`,
      {},
    )
    expect(response.status, await response.clone().text()).toBe(201)
    const body = (await response.json()) as { id: string; status: string; runId: string }

    // Then a proposal is awaiting confirmation
    expect(body.status).toBe('proposed')

    // and no task exists. The gate is the product's spine (CHAT-5), and a
    // decomposition that wrote tasks straight out would step around it while
    // looking like it worked.
    expect(await tasksIn(w)).toEqual([])

    // and it is reachable as a proposal like any other, so one confirmation
    // path serves every producer of one.
    const read = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/proposals/${body.id}`)
    ).json()) as { status: string; tree: { nodes: Array<{ title: string }> } }
    expect(read.tree.nodes[0]!.title).toBe('Split the invoice parser')
  })

  it('CHAT-5 AC6: a team set to auto gets its tasks without being asked, and the trace says so', async () => {
    // Given a team whose policy for `before_create_artefacts` is `auto`
    const w = await world()
    await policyIsAuto(w)
    models.script({ chunks: [JSON.stringify(proposal)] })

    // When decomposition runs
    const response = await w.ada.post(
      `/workspaces/${w.workspaceId}/documents/${w.documentId}/decompose`,
      {},
    )
    expect(response.status, await response.clone().text()).toBe(201)
    const body = (await response.json()) as { id: string; status: string; runId: string }

    // Then it materialised without a prompt
    expect(body.status).toBe('confirmed')
    const titles = (await tasksIn(w)).map((task) => task.title).sort()
    expect(titles).toEqual(['Extract parsing', 'Split the invoice parser'])

    // and the run says the decision was automatic rather than leaving a reader
    // to infer it from the absence of a checkpoint. "Nobody was asked" is a
    // fact about how these tasks came to exist, and the trace is where
    // somebody goes to find out.
    const trace = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/runs/${body.runId}/trace`)
    ).json()) as { events: Array<{ kind: string; payload: Record<string, unknown> }> }

    const decision = trace.events.find(
      (event) => event.payload.checkpointKind === 'before_create_artefacts',
    )
    expect(decision, 'the trace must record the gate that did not stop it').toBeDefined()
    expect(decision!.payload).toMatchObject({ mode: 'auto', decidedBy: 'policy' })
  })

  it('DOC-6 AC5: a task carries the acceptance criteria its section stated', async () => {
    // Given a document whose section states testable behaviour, and a team
    // that materialises without being asked
    const w = await world()
    await policyIsAuto(w)
    models.script({ chunks: [JSON.stringify(proposal)] })

    // When it is decomposed
    await w.ada.post(`/workspaces/${w.workspaceId}/documents/${w.documentId}/decompose`, {})

    // Then the created task carries the criteria rather than an empty
    // checklist. An empty one reads as "nobody has decided what done means
    // yet", which is a different and much weaker claim than the document made.
    const created = (await tasksIn(w)).find((task) => task.title === 'Extract parsing')!
    const detail = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/tasks/${created.id}`)
    ).json()) as { acceptanceCriteria: Array<{ text: string }> }

    expect(detail.acceptanceCriteria.map((criterion) => criterion.text)).toEqual([
      'A malformed invoice is rejected with a reason',
    ])
  })

  it('DOC-6 AC2: a created task links back to the document and the section it came from', async () => {
    // Given the same decomposition
    const w = await world()
    await policyIsAuto(w)
    models.script({ chunks: [JSON.stringify(proposal)] })
    await w.ada.post(`/workspaces/${w.workspaceId}/documents/${w.documentId}/decompose`, {})

    // When a created task is inspected
    const created = (await tasksIn(w)).find((task) => task.title === 'Extract parsing')!
    const detail = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/tasks/${created.id}`)
    ).json()) as {
      sources: Array<{ type: string; id: string; sectionKeys: string[] }>
    }

    // Then it names the document *and* the section. The document alone answers
    // "roughly where did this come from?", which is the answer a reviewer
    // already had; the section is what makes it checkable, and what lets a
    // later edit to that section flag this task as possibly stale.
    expect(detail.sources).toEqual([
      { type: 'document', id: w.documentId, sectionKeys: ['requirements'] },
    ])
  })

  it('DOC-6 AC1: the proposal records the document it came from', async () => {
    // Given a decomposed document
    const w = await world()
    models.script({ chunks: [JSON.stringify(proposal)] })
    const body = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/documents/${w.documentId}/decompose`, {})
    ).json()) as { id: string }

    // When the proposal is read
    const read = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/proposals/${body.id}`)
    ).json()) as { sourceDocumentId: string | null }

    // Then it names the document. Without it, "where did these tasks come
    // from?" is answerable only by reading the run, and the answer disappears
    // the day traces are pruned.
    expect(read.sourceDocumentId).toBe(w.documentId)
  })
})
