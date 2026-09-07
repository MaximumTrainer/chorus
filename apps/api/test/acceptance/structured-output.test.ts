import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ulid, WorkflowDefinitionSchema } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createExecutor, createToolRegistry } from '@chorus/agent'
import { createArtefactWriter } from '../../src/artefact-writer.js'
import { createDocumentService } from '../../src/documents.js'
import { createTaskService } from '../../src/tasks.js'
import { createPointerService } from '../../src/pointers.js'
import { createRetriever } from '@chorus/brain'
import { createFakeModelProvider, type FakeModelProvider } from '@chorus/testing'

/**
 * NFR-2 — structured output, and the silence it replaces.
 *
 * `architecture.md` §9.1 lists `generate<T>` as one of four entry points
 * `packages/llm` exposes. It did not exist, and what stood in for it was
 * outermost-braces scraping of a streamed string in the executor, whose every
 * failure returned `undefined`.
 *
 * That failure mode is the point of this suite. A model that returns prose, or
 * truncates, or emits a schema-shaped object with the wrong fields produced
 * nothing — and a run that quietly drafted nothing is indistinguishable, to
 * everything downstream, from one the user declined. The whole value of moving
 * the schema to the API boundary is turning a silent absence into a loud,
 * attributable failure.
 */
describe('NFR-2 structured output', () => {
  let db: IsolatedDatabase
  let models: FakeModelProvider

  interface World {
    workspaceId: string
    teamId: string
    userId: string
  }

  async function world(): Promise<World> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)

    const [member] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    const [team] = await db.admin.query<{ id: string }>(
      `SELECT id FROM teams WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )

    for (const table of ['documents', 'tasks', 'document_templates']) {
      await db.admin.execute(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId])
    }

    return { workspaceId, teamId: team!.id, userId: member!.user_id }
  }

  /**
   * A prompt declaring the schema its output must satisfy.
   *
   * §9.4 puts `outputSchema` in prompt front-matter rather than in the workflow
   * definition, and that is the right place: the shape a prompt asks for is a
   * property of the prompt, and moves with it when it is versioned.
   */
  function promptsDeclaring(outputSchema: string | undefined) {
    return {
      get: () => ({
        body: 'Draft a document about the invoice parser.',
        version: 1,
        hash: 'test-hash',
        ...(outputSchema ? { outputSchema } : {}),
      }),
    }
  }

  /** A model step that drafts, and an emit step that writes what it drafted. */
  const definition = WorkflowDefinitionSchema.parse({
    name: 'drafting-flow',
    version: 1,
    steps: [
      { id: 'draft', type: 'model', prompt: 'document/draft' },
      { id: 'write', type: 'emit', artefact: 'prd' },
    ],
  })

  async function run(w: World, outputSchema: string | undefined) {
    const executor = createExecutor(db.config, {
      registry: createToolRegistry([]),
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      prompts: promptsDeclaring(outputSchema),
      artefacts: createArtefactWriter(db.config, {
        documents: createDocumentService(db.config),
        tasks: createTaskService(db.config),
        pointers: createPointerService(
          db.config,
          createRetriever(db.config, {
            models,
            embeddingModel: { provider: 'fake', model: 'fake-embed' },
          }),
        ),
      }),
    })

    const record = await executor.start({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      startedBy: w.userId,
      definition,
      input: {},
    })
    return { runId: record.id, outcome: await executor.run(w.workspaceId, record.id) }
  }

  async function documents(w: World): Promise<Array<{ title: string }>> {
    return db.admin.query<{ title: string }>(
      `SELECT title FROM documents WHERE workspace_id = $1`,
      [w.workspaceId],
    )
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    models = createFakeModelProvider()
  })

  it('NFR-2 AC1: a model step whose prompt declares a schema drafts through it', async () => {
    // Given a model that returns a well-formed draft
    const w = await world()
    models.script({
      structured: {
        kind: 'document',
        title: 'The invoice parser does three jobs',
        documentType: 'prd',
        sections: {},
      },
    })

    // When the workflow runs
    const { outcome } = await run(w, 'artefact_draft')

    // Then the artefact is written from validated output
    expect(outcome.status, `run should have completed: ${outcome.error ?? ''}`).toBe('succeeded')
    expect(await documents(w)).toEqual([{ title: 'The invoice parser does three jobs' }])
  })

  it('NFR-2 AC1: the request carries the schema, so the provider constrains the reply', async () => {
    // Given a run whose prompt declares a schema
    const w = await world()
    models.script({
      structured: { kind: 'document', title: 'A title', documentType: 'prd', sections: {} },
    })

    // When it runs
    await run(w, 'artefact_draft')

    // Then the model was asked for that shape rather than asked in prose and
    // parsed afterwards — which is the whole difference this change makes.
    expect(models.requests()[0]).toMatchObject({ schemaName: 'artefact_draft' })
  })

  it('NFR-2 AC2: schema-invalid output fails the run and writes nothing', async () => {
    // Given a model whose reply is shaped like an artefact but is not one:
    // the title, which everything downstream needs, is missing.
    const w = await world()
    models.script({ schemaInvalid: { kind: 'document', documentType: 'prd', sections: {} } })

    // When the workflow runs
    const { outcome } = await run(w, 'artefact_draft')

    // Then the run fails, naming what was wrong
    expect(outcome.status).toBe('failed')
    expect(outcome.error ?? '').toMatch(/title/i)

    // and no artefact exists. Before this, the step completed and wrote
    // nothing, which reads downstream exactly like a user declining.
    expect(await documents(w)).toEqual([])
  })

  it('NFR-2 AC4: prose wrapped around the object is still accepted', async () => {
    // Given a provider that ignores the schema instruction and explains itself
    // first — some do, and the tolerance the old scraping provided is worth
    // keeping. Kept deliberately and tested, rather than by accident.
    const w = await world()
    models.script({
      chunks: [
        'Here is the document you asked for:\n\n',
        JSON.stringify({
          kind: 'document',
          title: 'Wrapped in prose',
          documentType: 'prd',
          sections: {},
        }),
        '\n\nLet me know if you want changes.',
      ],
    })

    // When it runs
    const { outcome } = await run(w, 'artefact_draft')

    // Then the draft is recovered rather than lost
    expect(outcome.status, `run should have completed: ${outcome.error ?? ''}`).toBe('succeeded')
    expect(await documents(w)).toEqual([{ title: 'Wrapped in prose' }])
  })

  it('NFR-2: a prompt that declares no schema still streams, as chat does', async () => {
    // Not every model step wants an object. A chat turn wants tokens as they
    // arrive, and requiring a schema everywhere would make streaming the
    // exception rather than the primary shape (§9.1).
    const w = await world()
    models.script({ chunks: ['Some prose, ', 'not an artefact.'] })

    const { outcome } = await run(w, undefined)

    // The run fails at the *emit* — there is no artefact in a paragraph — but
    // it fails there rather than at the model call, which is the distinction.
    expect(outcome.status).toBe('failed')
    expect(models.requests()[0]?.schemaName).toBeUndefined()
  })
})
