import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid } from '@chorus/core'
import { createExecutor, createToolRegistry, loadWorkflowDirectory, WORKFLOW_ROOT } from '@chorus/agent'
import { loadPromptDirectory } from '@chorus/llm'
import { createRetriever } from '@chorus/brain'
import { createFakeModelProvider } from '@chorus/testing'
import { createArtefactWriter } from '../../src/artefact-writer.js'
import { createDocumentService } from '../../src/documents.js'
import { createTaskService } from '../../src/tasks.js'
import { createPointerService } from '../../src/pointers.js'

/**
 * AGENT-1 AC6 — every built-in workflow has a golden test.
 *
 * > **Then** each produces the expected artefact shape from a fixed context
 * > bundle and scripted model responses.
 *
 * The point is not that a workflow runs. It is that a workflow whose steps,
 * prompt or output contract changed produces a *visibly different artefact*,
 * caught here rather than by whoever asked for a PRD and got something else.
 *
 * So this suite is generated from the shipped set rather than written per
 * workflow: adding a definition with no golden fails, which is what keeps the
 * requirement's word "every" true as the set grows.
 */
const goldenRoot = join(WORKFLOW_ROOT, '_goldens')

interface Golden {
  readonly input: Record<string, unknown>
  /** Indexed before the run, so a retrieve step has something real to find. */
  readonly context: ReadonlyArray<{ path: string; text: string }>
  /** What the model is scripted to say, as it would stream it. */
  readonly model: { chunks: string[] }
  readonly expect: {
    kind: 'document' | 'task'
    title: string
    type?: string
    sections?: Record<string, string>
    acceptanceCriteria?: string[]
  }
}

describe('AGENT-1 AC6 built-in workflow goldens', () => {
  let db: IsolatedDatabase

  const prompts = loadPromptDirectory(join(WORKFLOW_ROOT, '..', 'prompts'))
  const registry = loadWorkflowDirectory(WORKFLOW_ROOT, { tools: [], prompts: prompts.ids() })
  const shipped = registry.all()

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('AGENT-1 AC6: there is at least one built-in workflow, so this gate checks something', () => {
    // Without this, every assertion below would pass over an empty list — the
    // shape of vacuous coverage that is hardest to notice.
    expect(shipped.length).toBeGreaterThan(0)
  })

  it.each(shipped.map((definition) => [definition.name] as const))(
    'AGENT-1 AC6: %s has a recorded golden',
    (name) => {
      // A workflow with no golden would silently opt out of this suite, and
      // the moment it matters is the moment somebody adds the twelfth one.
      expect(
        existsSync(join(goldenRoot, `${name}.json`)),
        `add workflows/definitions/_goldens/${name}.json`,
      ).toBe(true)
    },
  )

  it.each(shipped.map((definition) => [definition.name, definition] as const))(
    'AGENT-1 AC6: %s produces the artefact its golden records',
    async (name, definition) => {
      const golden = JSON.parse(readFileSync(join(goldenRoot, `${name}.json`), 'utf8')) as Golden

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
      for (const table of ['code_chunks', 'code_files', 'documents', 'tasks', 'document_templates']) {
        await db.admin.execute(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId])
      }

      const models = createFakeModelProvider(golden.model)

      // A fixed context bundle, indexed with the same embedding the retriever
      // queries with, so "the workflow saw this" is a fact rather than a hope.
      for (const fragment of golden.context) {
        const fileId = ulid()
        await db.admin.execute(
          `INSERT INTO code_files (id, workspace_id, repository_id, path, lang, content_hash, commit_sha)
           VALUES ($1, $2, $3, $4, 'ts', $5, 'commit-1')`,
          [fileId, workspaceId, repo!.id, fragment.path, ulid()],
        )
        await db.admin.execute(
          `INSERT INTO code_chunks
             (id, workspace_id, repository_id, file_id, text, line_start, line_end, embedding)
           VALUES ($1, $2, $3, $4, $5, 1, 40, $6::vector)`,
          [
            ulid(),
            workspaceId,
            repo!.id,
            fileId,
            fragment.text,
            JSON.stringify(models.embedText(fragment.text)),
          ],
        )
      }

      const executor = createExecutor(db.config, {
        registry: createToolRegistry([]),
        models,
        modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
        prompts: { get: (id) => prompts.get(id) },
        retriever: createRetriever(db.config, {
          models,
          embeddingModel: { provider: 'fake', model: 'fake-embed' },
        }),
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
        workspaceId,
        teamId: team!.id,
        startedBy: member!.user_id,
        definition,
        input: golden.input,
      })
      const outcome = await executor.run(workspaceId, record.id)
      expect(outcome.status, outcome.error).toBe('succeeded')

      // What the model was *given*, not only what it said. A workflow whose
      // retrieval silently returned nothing still produces the scripted answer
      // and would pass every assertion below — grounding is precisely the thing
      // a scripted model cannot demonstrate on its own.
      const asked = models.requests()[0]
      expect(asked, 'the workflow made no model call').toBeDefined()
      for (const value of Object.values(golden.input)) {
        expect(asked!.prompt).toContain(String(value))
      }
      for (const fragment of golden.context) {
        expect(asked!.prompt).toContain(fragment.path)
      }

      if (golden.expect.kind === 'document') {
        const [row] = await db.admin.query<{ id: string; title: string; type: string }>(
          `SELECT id, title, type FROM documents WHERE workspace_id = $1`,
          [workspaceId],
        )
        expect(row!.title).toBe(golden.expect.title)
        expect(row!.type).toBe(golden.expect.type)

        // Through the service: the content is in the body, and the `sections`
        // column carries structure alone (DOC-2).
        const document = await createDocumentService(db.config).get(workspaceId, row!.id)
        for (const [key, content] of Object.entries(golden.expect.sections ?? {})) {
          expect(document.sections.find((section) => section.key === key)?.content).toBe(content)
        }
      } else {
        const [task] = await db.admin.query<{
          title: string
          acceptance_criteria: Array<{ text: string }>
        }>(`SELECT title, acceptance_criteria FROM tasks WHERE workspace_id = $1`, [workspaceId])

        expect(task!.title).toBe(golden.expect.title)
        expect(task!.acceptance_criteria.map((criterion) => criterion.text)).toEqual(
          golden.expect.acceptanceCriteria ?? [],
        )
      }
    },
    60_000,
  )
})
