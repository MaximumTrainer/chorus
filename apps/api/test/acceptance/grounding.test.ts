import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid, WorkflowDefinitionSchema } from '@chorus/core'
import { createExecutor, createToolRegistry } from '@chorus/agent'
import { createRetriever, type Retriever } from '@chorus/brain'
import { createFakeModelProvider, type FakeModelProvider } from '@chorus/testing'

/**
 * BRAIN-4 — a workflow grounded in what its person may actually see.
 *
 * This suite lives here rather than beside either package because it is about
 * the *seam*: the agent runtime consumes a `Retriever` interface from `core`,
 * and the brain implements one, and neither may import the other. Testing them
 * together from a package would recreate exactly the cycle the dependency rule
 * forbids — which the build caught when the first version of this tried it.
 *
 * The property under test is the one that makes an agent safe to point at a
 * codebase: "an agent is not a privileged actor" has to hold for what it can
 * *read* as much as for what it can do, or a workflow becomes a way to read any
 * team's code by asking nicely.
 */
describe('BRAIN-4 grounded workflows', () => {
  let db: IsolatedDatabase
  let models: FakeModelProvider
  let retriever: Retriever

  interface World {
    workspaceId: string
    insiderId: string
    outsiderId: string
    teamId: string
    repoId: string
  }

  async function world(): Promise<World> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)

    const [owner] = await db.admin.query<{ user_id: string }>(
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

    const outsiderId = ulid()
    await db.admin.execute(
      `INSERT INTO users (id, email, name, email_verified)
       VALUES ($1, $2, 'Outsider', true)`,
      [outsiderId, `outsider-${outsiderId}@example.test`],
    )
    await db.admin.execute(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, 'member')`,
      [ulid(), workspaceId, outsiderId],
    )

    await db.admin.execute(`DELETE FROM code_chunks WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM code_files WHERE workspace_id = $1`, [workspaceId])

    return {
      workspaceId,
      insiderId: owner!.user_id,
      outsiderId,
      teamId: team!.id,
      repoId: repo!.id,
    }
  }

  async function addChunk(
    w: World,
    input: { path: string; text: string; repoId?: string; symbol?: string },
  ): Promise<void> {
    const fileId = ulid()
    await db.admin.execute(
      `INSERT INTO code_files (id, workspace_id, repository_id, path, lang, content_hash)
       VALUES ($1, $2, $3, $4, 'ts', $5)`,
      [fileId, w.workspaceId, input.repoId ?? w.repoId, input.path, ulid()],
    )
    await db.admin.execute(
      `INSERT INTO code_chunks
         (id, workspace_id, file_id, text, line_start, line_end, symbol_name, embedding)
       VALUES ($1, $2, $3, $4, 1, 10, $5, $6::vector)`,
      [
        ulid(),
        w.workspaceId,
        fileId,
        input.text,
        input.symbol ?? null,
        `[${models.embedText(input.text).join(',')}]`,
      ],
    )
  }

  async function otherTeamRepo(w: World): Promise<string> {
    const teamId = ulid()
    await db.admin.execute(
      `INSERT INTO teams (id, workspace_id, name, slug) VALUES ($1, $2, 'Other', $3)`,
      [teamId, w.workspaceId, `other-${teamId.slice(-6).toLowerCase()}`],
    )
    const [integration] = await db.admin.query<{ id: string }>(
      `SELECT id FROM integrations WHERE workspace_id = $1 LIMIT 1`,
      [w.workspaceId],
    )
    const repoId = ulid()
    await db.admin.execute(
      `INSERT INTO repositories
         (id, workspace_id, team_id, integration_id, provider, full_name)
       VALUES ($1, $2, $3, $4, 'github', $5)`,
      [repoId, w.workspaceId, teamId, integration!.id, `acme/secret-${repoId.slice(-6)}`],
    )
    return repoId
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    models = createFakeModelProvider()
    retriever = createRetriever(db.config, {
      models,
      embeddingModel: { provider: 'fake', model: 'fake-embed' },
    })
  })

  it('BRAIN-4 AC2: a workflow retrieves as the person it acts for, not as the platform', async () => {
    const w = await world()
    const otherRepo = await otherTeamRepo(w)
    await addChunk(w, { path: 'src/open.ts', text: 'export function parseInvoice() {}' })
    await addChunk(w, {
      path: 'src/secret.ts',
      text: 'export function parseInvoice() { /* restricted */ }',
      repoId: otherRepo,
    })

    const executor = createExecutor(db.config, {
      registry: createToolRegistry([]),
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      retriever,
    })

    const run = await executor.start({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      // Started by the outsider, who is in the workspace but in no team that
      // owns a repository.
      startedBy: w.outsiderId,
      definition: WorkflowDefinitionSchema.parse({
        name: 'grounded-flow',
        version: 1,
        steps: [{ id: 'gather', type: 'retrieve', query: 'parseInvoice' }],
      }),
      input: {},
    })
    const outcome = await executor.run(w.workspaceId, run.id)
    expect(outcome.status).toBe('succeeded')

    const [step] = await db.admin.query<{ output: { fragments: unknown[] } }>(
      `SELECT output FROM run_steps WHERE run_id = $1 AND step_id = 'gather'`,
      [run.id],
    )
    // "An agent is not a privileged actor" has to hold for what it can *read*
    // as much as for what it can do. A workflow that retrieved as the platform
    // would be a way to read any team's code by asking an agent nicely.
    expect(step!.output.fragments).toEqual([])
  })

  it('BRAIN-4 AC4: a retrieve step persists its bundle, so the run can be replayed against it', async () => {
    const w = await world()
    await addChunk(w, { path: 'src/open.ts', text: 'export function parseInvoice() {}' })

    const executor = createExecutor(db.config, {
      registry: createToolRegistry([]),
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      retriever,
    })

    const run = await executor.start({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      startedBy: w.insiderId,
      definition: WorkflowDefinitionSchema.parse({
        name: 'grounded-flow',
        version: 1,
        steps: [{ id: 'gather', type: 'retrieve', query: 'parseInvoice' }],
      }),
      input: {},
    })
    await executor.run(w.workspaceId, run.id)

    const [step] = await db.admin.query<{ output: { id: string; fragments: unknown[] } }>(
      `SELECT output FROM run_steps WHERE run_id = $1 AND step_id = 'gather'`,
      [run.id],
    )
    expect(step!.output.fragments).toHaveLength(1)

    // The bundle is on disk, not merely in the step's output. That is what
    // makes the "Context used" panel exact rather than reconstructed.
    const stored = await retriever.load(w.workspaceId, step!.output.id)
    expect(stored?.fragments).toHaveLength(1)
  })

  it('BRAIN-4: a runtime with no retriever refuses rather than grounding on nothing', async () => {
    const w = await world()
    await addChunk(w, { path: 'src/open.ts', text: 'export function parseInvoice() {}' })

    const executor = createExecutor(db.config, {
      registry: createToolRegistry([]),
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      // No retriever.
    })

    const run = await executor.start({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      startedBy: w.insiderId,
      definition: WorkflowDefinitionSchema.parse({
        name: 'grounded-flow',
        version: 1,
        steps: [{ id: 'gather', type: 'retrieve', query: 'parseInvoice' }],
      }),
      input: {},
    })
    const outcome = await executor.run(w.workspaceId, run.id)

    // An empty bundle here would be a lie: the workflow would then answer
    // confidently from no evidence, which is the worst failure this system has.
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatch(/no retriever/i)
  })

})
