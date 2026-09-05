import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid, WorkflowDefinitionSchema } from '@chorus/core'
import { z } from 'zod'
import { createExecutor, createToolRegistry } from '@chorus/agent'
import { createRetriever } from '@chorus/brain'
import { createFakeModelProvider, type FakeModelProvider } from '@chorus/testing'
import { createArtefactWriter } from '../../src/artefact-writer.js'
import { createDocumentService } from '../../src/documents.js'
import { createTaskService } from '../../src/tasks.js'
import { createPointerService } from '../../src/pointers.js'

/**
 * AGENT-1 — the emit step, and the one guarantee it carries.
 *
 * > the emit step validates that every pointer resolves to a real file at a
 * > real commit before an artefact is written.  (architecture.md 11.7)
 *
 * The ordering is the whole requirement and it is easy to get backwards. An
 * artefact written first and checked afterwards has already been seen, linked
 * to and acted on by the time anybody notices a citation goes nowhere — and a
 * model that produced one plausible-looking citation will have produced others.
 * So these tests assert on what is *in the database* after a refusal, not only
 * that an error was raised: an implementation that writes and then half undoes
 * itself is the failure mode worth catching.
 *
 * This suite sits here rather than beside either package because it is about
 * the seam. The runtime consumes an `ArtefactWriter` from `core`; the API
 * implements one over the document, task and pointer services; neither package
 * imports the other. There is no HTTP route that starts a run — runs are
 * started by the router and the worker — so the executor is driven directly,
 * and everything beneath it is real.
 */
describe('AGENT-1 emit', () => {
  let db: IsolatedDatabase
  let models: FakeModelProvider

  interface World {
    workspaceId: string
    teamId: string
    userId: string
    repositoryId: string
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
    const [repo] = await db.admin.query<{ id: string }>(
      `SELECT id FROM repositories WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )

    // The seed makes a workspace look lived-in, which is right for most
    // suites and wrong for counting what an emit step wrote.
    for (const table of [
      'code_pointers',
      'code_chunks',
      'code_files',
      'documents',
      'tasks',
      // The seed configures an empty prd template. Removing it puts the team
      // on the default one, which is what a team that has never edited a
      // template actually has.
      'document_templates',
    ]) {
      await db.admin.execute(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId])
    }

    return { workspaceId, teamId: team!.id, userId: member!.user_id, repositoryId: repo!.id }
  }

  /** Puts a file in the index, so a citation to it resolves. */
  async function indexFile(w: World, path: string, lastLine = 40): Promise<void> {
    const fileId = ulid()
    await db.admin.execute(
      `INSERT INTO code_files (id, workspace_id, repository_id, path, lang, content_hash, commit_sha)
       VALUES ($1, $2, $3, $4, 'ts', $5, 'commit-1')`,
      [fileId, w.workspaceId, w.repositoryId, path, ulid()],
    )
    await db.admin.execute(
      `INSERT INTO code_chunks
         (id, workspace_id, repository_id, file_id, text, line_start, line_end, symbol_name)
       VALUES ($1, $2, $3, $4, 'export function parseInvoice() {}', 1, $5, 'parseInvoice')`,
      [ulid(), w.workspaceId, w.repositoryId, fileId, lastLine],
    )
  }

  /**
   * A workflow that proposes a draft in one step and emits it in the next.
   *
   * The proposing step is a tool rather than a model call because what is under
   * test is the emit, and a scripted tool result is the same shape as a
   * scripted model result without the JSON-in-prose question in the way.
   */
  function emitting(artefact: string, draft: unknown) {
    const tool = {
      name: 'propose',
      description: 'Proposes an artefact',
      input: z.object({}).passthrough(),
      output: z.unknown(),
      sideEffect: 'none' as const,
      requiredRole: 'member' as const,
      requiredScopes: [] as const,
      execute: async () => draft,
    }

    return {
      tool,
      definition: WorkflowDefinitionSchema.parse({
        name: 'emitting-flow',
        version: 1,
        tools: ['propose'],
        steps: [
          { id: 'propose', type: 'tool', tool: 'propose' },
          { id: 'write', type: 'emit', artefact },
        ],
      }),
    }
  }

  function writer() {
    return createArtefactWriter(db.config, {
      documents: createDocumentService(db.config),
      tasks: createTaskService(db.config),
      pointers: createPointerService(
        db.config,
        createRetriever(db.config, {
          models,
          embeddingModel: { provider: 'fake', model: 'fake-embed' },
        }),
      ),
    })
  }

  async function run(w: World, artefact: string, draft: unknown) {
    const { tool, definition } = emitting(artefact, draft)

    const executor = createExecutor(db.config, {
      registry: createToolRegistry([tool as never]),
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      artefacts: writer(),
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

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    models = createFakeModelProvider()
  })

  it('AGENT-1: an emit step writes the document a workflow proposed', async () => {
    const w = await world()
    const { outcome } = await run(w, 'prd', {
      title: 'Invoice splitting',
      documentType: 'prd',
      sections: { problem: 'Finance spends a day a week reconciling part-payments.' },
    })

    expect(outcome.status, outcome.error).toBe('succeeded')

    // Read through the service rather than out of the `sections` column, which
    // carries structure only: a document's content is its body (DOC-2), and a
    // test reading the column would be asserting on the wrong thing while
    // looking like it asserted on the right one.
    const [doc] = await db.admin.query<{ id: string; title: string }>(
      `SELECT id, title FROM documents WHERE workspace_id = $1`,
      [w.workspaceId],
    )
    expect(doc!.title).toBe('Invoice splitting')

    const stored = await createDocumentService(db.config).get(w.workspaceId, doc!.id)
    expect(stored.sections.find((section) => section.key === 'problem')!.content).toContain(
      'day a week',
    )
  })

  it('AGENT-1: an emit step writes a task with its acceptance criteria', async () => {
    const w = await world()
    const { outcome } = await run(w, 'task', {
      title: 'Split the invoice parser',
      acceptanceCriteria: ['Each line parses', 'A bad line names its number'],
      tags: ['coding'],
    })

    expect(outcome.status, outcome.error).toBe('succeeded')
    const [task] = await db.admin.query<{
      title: string
      acceptance_criteria: Array<{ text: string }>
      tags: string[]
    }>(`SELECT title, acceptance_criteria, tags FROM tasks WHERE workspace_id = $1`, [
      w.workspaceId,
    ])

    expect(task!.title).toBe('Split the invoice parser')
    // In the order they were written: criteria are read as a sequence, and a
    // set would be a different thing.
    expect(task!.acceptance_criteria.map((criterion) => criterion.text)).toEqual([
      'Each line parses',
      'A bad line names its number',
    ])
    // Through the same normalisation a person typing a tag goes through, so a
    // reserved tag an agent emitted still routes.
    expect(task!.tags).toContain('Coding')
  })

  it('AGENT-1 11.7: a citation that does not resolve refuses the whole artefact', async () => {
    const w = await world()
    await indexFile(w, 'src/real.ts')

    const { outcome } = await run(w, 'task', {
      title: 'Cites something imaginary',
      pointers: [
        { repositoryId: w.repositoryId, path: 'src/real.ts', lineStart: 1, lineEnd: 10 },
        { repositoryId: w.repositoryId, path: 'src/invented.ts', lineStart: 1, lineEnd: 10 },
      ],
    })

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatch(/not in the index/i)

    // Nothing written: not the task, and not the citation that would have
    // resolved. A half-written artefact says less than the workflow claimed
    // while looking complete, which is the failure nobody notices.
    const [tasks] = await db.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tasks WHERE workspace_id = $1`,
      [w.workspaceId],
    )
    expect(tasks!.n).toBe('0')
    const [pointers] = await db.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM code_pointers WHERE workspace_id = $1`,
      [w.workspaceId],
    )
    expect(pointers!.n).toBe('0')
  })

  it('AGENT-1 11.7: a line range past the end of a cited file is refused too', async () => {
    const w = await world()
    await indexFile(w, 'src/short.ts', 12)

    const { outcome } = await run(w, 'task', {
      title: 'Cites past the end',
      pointers: [{ repositoryId: w.repositoryId, path: 'src/short.ts', lineStart: 1, lineEnd: 400 }],
    })

    // The file is real, so a check that only asks whether the path exists
    // passes it. A range past the end opens to a blank screen rather than an
    // error, which is the kind of broken citation a reader does not notice is
    // broken.
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatch(/past the end/i)
  })

  it('AGENT-1: a citation that resolves is written alongside the artefact', async () => {
    const w = await world()
    await indexFile(w, 'src/real.ts')

    const { outcome } = await run(w, 'task', {
      title: 'Well cited',
      pointers: [{ repositoryId: w.repositoryId, path: 'src/real.ts', lineStart: 1, lineEnd: 10 }],
    })

    // Without this the refusal tests above would pass just as well against a
    // writer that never wrote a pointer at all.
    expect(outcome.status, outcome.error).toBe('succeeded')
    const [pointer] = await db.admin.query<{ path: string; commit_sha: string }>(
      `SELECT path, commit_sha FROM code_pointers WHERE workspace_id = $1`,
      [w.workspaceId],
    )
    expect(pointer!.path).toBe('src/real.ts')
    // At a real commit rather than at whatever is current, which is what
    // makes it re-checkable later.
    expect(pointer!.commit_sha).toBe('commit-1')
  })

  it('AGENT-1 11.7: a section the template does not have is refused whole', async () => {
    const w = await world()

    const { outcome } = await run(w, 'prd', {
      title: 'Written against an older template',
      documentType: 'prd',
      sections: { problem: 'Real enough.', invented: 'Written for a section nobody has.' },
    })

    // A workflow drafted against a template the team has since changed. The
    // alternative — dropping the unknown section and writing the rest — is how
    // somebody loses a paragraph without ever seeing it happen.
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatch(/template does not have/i)

    // And no husk left behind. A document with a title and no content is
    // indistinguishable from one somebody started and abandoned, so it stays
    // in the list being reopened by people wondering what it was for.
    const [documents] = await db.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM documents WHERE workspace_id = $1`,
      [w.workspaceId],
    )
    expect(documents!.n).toBe('0')
  })

  it('AGENT-1: an emit step records the artefact in the run trace', async () => {
    const w = await world()
    const { runId, outcome } = await run(w, 'prd', { title: 'Traced', documentType: 'prd' })
    expect(outcome.status, outcome.error).toBe('succeeded')

    const [event] = await db.admin.query<{ payload: { kind: string; artefactId: string } }>(
      `SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'artefact'`,
      [runId],
    )
    // A run that produced an artefact and did not say so leaves the artefact
    // unattributable: nobody can ask which run wrote it, or why.
    expect(event!.payload.kind).toBe('document')
    expect(event!.payload.artefactId).toBeTruthy()
  })

  it('AGENT-1: a step that produced nothing artefact-shaped fails, naming the step', async () => {
    const w = await world()

    // A model preamble is not an artefact. Guessing a title from its first
    // line produces a document nobody asked for, which is harder to notice
    // than a failure somebody can act on.
    const { outcome } = await run(w, 'prd', 'Here is my thinking about invoices.')

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatch(/nothing to emit/i)
  })

  it('AGENT-1: an emit step with no writer configured refuses rather than pretending', async () => {
    const w = await world()
    const { tool, definition } = emitting('prd', { title: 'Unwritable' })

    const bare = createExecutor(db.config, {
      registry: createToolRegistry([tool as never]),
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
    })
    const record = await bare.start({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      startedBy: w.userId,
      definition,
      input: {},
    })
    const outcome = await bare.run(w.workspaceId, record.id)

    // Succeeding here would send the person who asked for a document looking
    // for one that was never written.
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatch(/no artefact writer/i)
  })
})
