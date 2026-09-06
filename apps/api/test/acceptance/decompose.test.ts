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

  /** A connected, indexed repository, so pointers have something to resolve to. */
  async function indexed(w: World, input: { path: string; text: string }): Promise<void> {
    const [existing] = await db.admin.query<{ id: string }>(
      `SELECT id FROM repositories WHERE workspace_id = $1 LIMIT 1`,
      [w.workspaceId],
    )
    let repoId = existing?.id
    if (!repoId) {
      const integrationId = ulid()
      await db.admin.execute(
        `INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'github')`,
        [integrationId, w.workspaceId],
      )
      repoId = ulid()
      await db.admin.execute(
        `INSERT INTO repositories (id, workspace_id, team_id, integration_id, provider, full_name)
         VALUES ($1, $2, $3, $4, 'github', $5)`,
        [repoId, w.workspaceId, w.teamId, integrationId, `acme/invoices-${repoId.slice(-6)}`],
      )
    }
    const fileId = ulid()
    await db.admin.execute(
      `INSERT INTO code_files (id, workspace_id, repository_id, path, lang, content_hash, commit_sha)
       VALUES ($1, $2, $3, $4, 'ts', $5, 'commit-1')`,
      [fileId, w.workspaceId, repoId, input.path, ulid()],
    )
    await db.admin.execute(
      `INSERT INTO code_chunks
         (id, workspace_id, repository_id, file_id, text, line_start, line_end, symbol_name, embedding)
       VALUES ($1, $2, $3, $4, $5, 1, 20, 'parseInvoice', $6::vector)`,
      [
        ulid(),
        w.workspaceId,
        repoId,
        fileId,
        input.text,
        `[${models.embedText(input.text).join(',')}]`,
      ],
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
        // Pointer routes mount only with a provider, because generating a
        // pointer is a retrieval (TASK-3).
        models,
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

  it('DOC-6 AC4: re-decomposing an extended document proposes only the new work', async () => {
    // Given a document already decomposed into tasks
    const w = await world()
    await policyIsAuto(w)
    models.script({ chunks: [JSON.stringify(proposal)] })
    await w.ada.post(`/workspaces/${w.workspaceId}/documents/${w.documentId}/decompose`, {})
    expect((await tasksIn(w)).length).toBe(2)

    // When it is extended and decomposed again, and the model proposes the
    // work it proposed before *plus* something new — which is what a model
    // reading a superset of the same document will do
    models.script({
      chunks: [
        JSON.stringify({
          nodes: [
            ...proposal.nodes,
            {
              key: 'refunds',
              title: 'Handle partial refunds',
              size: 'M',
              tags: ['billing'],
              sectionKeys: ['requirements'],
              children: [],
            },
          ],
        }),
      ],
    })
    const second = await w.ada.post(
      `/workspaces/${w.workspaceId}/documents/${w.documentId}/decompose`,
      {},
    )
    expect(second.status, await second.clone().text()).toBe(201)

    // Then only the genuinely new work becomes a task. Proposing the same two
    // again is the failure everybody has seen: the second run doubles the
    // board, and the person who asked for one new task spends their afternoon
    // deleting the others.
    const titles = (await tasksIn(w)).map((task) => task.title).sort()
    expect(titles).toEqual([
      'Extract parsing',
      'Handle partial refunds',
      'Split the invoice parser',
    ])

    // and the recognised nodes are reported rather than silently dropped, so a
    // reader can see the run considered them and decided they already existed.
    const body = (await second.json()) as { existing: Array<{ nodeKey: string; taskId: string }> }
    expect(body.existing.map((entry) => entry.nodeKey).sort()).toEqual(['billing', 'parse'])
  })

  it('DOC-6 AC3: a coding task gets a pointer that resolves, and a vague one gets none', async () => {
    // Given an indexed repository holding the code one task is about
    const w = await world()
    await policyIsAuto(w)
    await indexed(w, {
      path: 'src/invoice.ts',
      text: 'export function parseInvoice(line: string) {}',
    })

    // and a proposal with one task named for that code and one that could
    // match nothing in it
    models.script({
      chunks: [
        JSON.stringify({
          nodes: [
            // A title as somebody would actually write it. It used to find
            // nothing, because the lexical search required every term and the
            // code contains no "fix" (#160).
            { key: 'fix', title: 'Fix parseInvoice so it balances', tags: [], sectionKeys: [], children: [] },
            {
              key: 'board',
              title: 'Write the quarterly board update',
              tags: [],
              sectionKeys: [],
              children: [],
            },
          ],
        }),
      ],
    })

    // When decomposition runs and materialises
    await w.ada.post(`/workspaces/${w.workspaceId}/documents/${w.documentId}/decompose`, {})

    // Then the coding task carries a pointer that resolves to a real file at a
    // real commit
    const tasks = await tasksIn(w)
    const coding = tasks.find((task) => task.title === 'Fix parseInvoice so it balances')!
    const pointers = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/tasks/${coding.id}/pointers`)
    ).json()) as Array<{ path: string; commitSha: string | null; staleAt: string | null }>

    expect(pointers.length).toBeGreaterThan(0)
    // Resolving means a real file at a real commit, and not marked stale.
    expect(pointers[0]).toMatchObject({ path: 'src/invoice.ts', staleAt: null })
    expect(pointers[0]!.commitSha).toBe('commit-1')

    // and the one with nothing to match carries none rather than a guess.
    // TASK-3's floor is high on purpose: the costs are not symmetric. A pointer
    // to the wrong file sends somebody to read code that has nothing to do with
    // their task, and quietly teaches them to distrust all of them.
    const vague = tasks.find((task) => task.title === 'Write the quarterly board update')!
    const none = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/tasks/${vague.id}/pointers`)
    ).json()) as unknown[]
    expect(none).toEqual([])
  })

  it('DOC-6 AC4: re-decomposing an extended document proposes only the new work', async () => {
    // Given a document already decomposed into tasks
    const w = await world()
    await policyIsAuto(w)
    models.script({ chunks: [JSON.stringify(proposal)] })
    await w.ada.post(`/workspaces/${w.workspaceId}/documents/${w.documentId}/decompose`, {})
    expect((await tasksIn(w)).length).toBe(2)

    // When it is extended and decomposed again, and the model proposes the
    // work it proposed before *plus* something new — which is what a model
    // reading a superset of the same document will do
    models.script({
      chunks: [
        JSON.stringify({
          nodes: [
            ...proposal.nodes,
            {
              key: 'refunds',
              title: 'Handle partial refunds',
              size: 'M',
              tags: ['billing'],
              sectionKeys: ['requirements'],
              children: [],
            },
          ],
        }),
      ],
    })
    const second = await w.ada.post(
      `/workspaces/${w.workspaceId}/documents/${w.documentId}/decompose`,
      {},
    )
    expect(second.status, await second.clone().text()).toBe(201)

    // Then only the genuinely new work becomes a task. Proposing the same two
    // again is the failure everybody has seen: the second run doubles the
    // board, and the person who asked for one new task spends their afternoon
    // deleting the others.
    const titles = (await tasksIn(w)).map((task) => task.title).sort()
    expect(titles).toEqual([
      'Extract parsing',
      'Handle partial refunds',
      'Split the invoice parser',
    ])

    // and the recognised nodes are reported rather than silently dropped, so a
    // reader can see the run considered them and decided they already existed.
    const body = (await second.json()) as { existing: Array<{ nodeKey: string; taskId: string }> }
    expect(body.existing.map((entry) => entry.nodeKey).sort()).toEqual(['billing', 'parse'])
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
