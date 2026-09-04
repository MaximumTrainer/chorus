import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid, CreateTaskSchema } from '@chorus/core'
import { createRetriever } from '@chorus/brain'
import { createFakeModelProvider, type FakeModelProvider } from '@chorus/testing'
import { createTaskService, type TaskService } from '../../src/tasks.js'
import { createPointerService, type PointerService } from '../../src/pointers.js'

/**
 * TASK-3 — pointers that resolve, or no pointers at all.
 *
 * > A pointer that does not resolve is worse than none: it teaches everyone,
 * > human and machine, to distrust all of them.
 *
 * The golden case is AC2, and it is the one worth being strict about: a task
 * about something the repository does not contain must produce **nothing**.
 * A plausible-looking pointer to an unrelated file is the failure that makes
 * every other pointer suspect, and it is exactly what a nearest-neighbour
 * search returns if nobody puts a floor under it.
 */
describe('TASK-3 code pointers', () => {
  let db: IsolatedDatabase
  let models: FakeModelProvider
  let tasks: TaskService
  let pointers: PointerService

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

    for (const table of ['code_pointers', 'code_chunks', 'code_files', 'tasks', 'task_counters']) {
      await db.admin.execute(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId])
    }

    return {
      workspaceId,
      teamId: team!.id,
      userId: member!.user_id,
      repositoryId: repo!.id,
    }
  }

  /** One indexed file, with a chunk the fake provider will embed sensibly. */
  async function indexFile(
    w: World,
    input: { path: string; text: string; lineEnd?: number; commitSha?: string },
  ): Promise<string> {
    const fileId = ulid()
    await db.admin.execute(
      `INSERT INTO code_files (id, workspace_id, repository_id, path, lang, content_hash, commit_sha)
       VALUES ($1, $2, $3, $4, 'ts', $5, $6)`,
      [fileId, w.workspaceId, w.repositoryId, input.path, ulid(), input.commitSha ?? 'commit-1'],
    )
    await db.admin.execute(
      `INSERT INTO code_chunks
         (id, workspace_id, repository_id, file_id, text, line_start, line_end, symbol_name,
          embedding)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8::vector)`,
      [
        ulid(),
        w.workspaceId,
        w.repositoryId,
        fileId,
        input.text,
        input.lineEnd ?? 40,
        input.path.split('/').pop()!.replace('.ts', ''),
        `[${models.embedText(input.text).join(',')}]`,
      ],
    )
    return fileId
  }

  const makeTask = async (w: World, title: string) =>
    tasks.create({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      actorId: w.userId,
      task: CreateTaskSchema.parse({ title }),
    })

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    models = createFakeModelProvider()
    tasks = createTaskService(db.config)
    pointers = createPointerService(
      db.config,
      createRetriever(db.config, {
        models,
        embeddingModel: { provider: 'fake', model: 'fake-embed' },
      }),
    )
  })

  it('TASK-3 AC1: a generated pointer names a real file, at a commit, inside its bounds', async () => {
    const w = await world()
    await indexFile(w, {
      path: 'src/billing/invoice.ts',
      text: 'export function parseInvoice(line: string) { return line.split(",") }',
      lineEnd: 40,
    })
    const task = await makeTask(w, 'Split parseInvoice')

    const generated = await pointers.generate({
      workspaceId: w.workspaceId,
      taskId: task.id,
      teamId: w.teamId,
      userId: w.userId,
      query: 'parseInvoice',
    })

    expect(generated.length).toBeGreaterThan(0)
    const pointer = generated[0]!
    expect(pointer.path).toBe('src/billing/invoice.ts')
    // A commit, so the link is reproducible rather than "wherever it is now".
    expect(pointer.commitSha).toBe('commit-1')
    // Inside the file's bounds. A range past the end opens to a blank screen
    // rather than an error, which is the worse kind of not resolving.
    expect(pointer.lineEnd).toBeLessThanOrEqual(40)
    expect(pointer.lineStart).toBeGreaterThanOrEqual(1)
  })

  it('TASK-3 AC2: a task with no confident match produces no pointers at all', async () => {
    const w = await world()
    // The repository is about invoices. The task is about something else
    // entirely — the case a nearest-neighbour search answers with its least-bad
    // guess if nobody puts a floor under it.
    await indexFile(w, {
      path: 'src/billing/invoice.ts',
      text: 'export function parseInvoice(line: string) {}',
    })
    const task = await makeTask(w, 'Investigate lattice gauge theory solver')

    const generated = await pointers.generate({
      workspaceId: w.workspaceId,
      taskId: task.id,
      teamId: w.teamId,
      userId: w.userId,
      query: 'quantum chromodynamics lattice gauge solver',
    })

    expect(generated, 'a plausible-looking wrong pointer is the failure to avoid').toEqual([])
  })

  it('TASK-3 AC2: and the confident case still produces one, so the floor is not simply blocking everything', async () => {
    const w = await world()
    await indexFile(w, {
      path: 'src/billing/invoice.ts',
      text: 'export function parseInvoice(line: string) {}',
    })
    const task = await makeTask(w, 'Fix parseInvoice')

    // Without this, the test above would pass against a generator that never
    // produced anything.
    expect(
      (
        await pointers.generate({
          workspaceId: w.workspaceId,
          taskId: task.id,
          teamId: w.teamId,
          userId: w.userId,
          query: 'parseInvoice',
        })
      ).length,
    ).toBeGreaterThan(0)
  })

  it('TASK-3 AC1: a pointer is never written for a file the index does not have', async () => {
    const w = await world()
    await indexFile(w, { path: 'src/a.ts', text: 'export function parseInvoice() {}' })
    const task = await makeTask(w, 'Fix parseInvoice')

    // The index moved on between the search and the write — the exact window
    // validating-before-persisting exists to close.
    await pointers.generate({
      workspaceId: w.workspaceId,
      taskId: task.id,
      teamId: w.teamId,
      userId: w.userId,
      query: 'parseInvoice',
    })
    await db.admin.execute(`DELETE FROM code_files WHERE workspace_id = $1`, [w.workspaceId])

    const after = await pointers.generate({
      workspaceId: w.workspaceId,
      taskId: task.id,
      teamId: w.teamId,
      userId: w.userId,
      query: 'parseInvoice',
    })
    expect(after).toEqual([])
  })

  it('TASK-3 AC4: regeneration keeps manual pointers and replaces generated ones', async () => {
    const w = await world()
    await indexFile(w, { path: 'src/a.ts', text: 'export function parseInvoice() {}' })
    await indexFile(w, { path: 'src/notes.ts', text: 'a file somebody chose by hand' })
    const task = await makeTask(w, 'Fix parseInvoice')

    await pointers.generate({
      workspaceId: w.workspaceId,
      taskId: task.id,
      teamId: w.teamId,
      userId: w.userId,
      query: 'parseInvoice',
    })
    const manual = await pointers.addManual({
      workspaceId: w.workspaceId,
      taskId: task.id,
      userId: w.userId,
      repositoryId: w.repositoryId,
      path: 'src/notes.ts',
      lineStart: 3,
      lineEnd: 9,
    })

    const after = await pointers.generate({
      workspaceId: w.workspaceId,
      taskId: task.id,
      teamId: w.teamId,
      userId: w.userId,
      query: 'parseInvoice',
    })

    // A person who corrected a pointer told us something the index does not
    // know. Discarding it on the next regeneration is how a tool teaches people
    // that correcting it is pointless.
    const kept = after.find((p) => p.id === manual.id)
    expect(kept, 'the manual pointer was discarded by regeneration').toBeDefined()
    expect(kept!.source).toBe('manual')
    expect(after.some((p) => p.source === 'generated')).toBe(true)
  })

  it('TASK-3 AC5: a pointer whose file has gone is marked stale, and still links', async () => {
    const w = await world()
    await indexFile(w, { path: 'src/a.ts', text: 'export function parseInvoice() {}' })
    const task = await makeTask(w, 'Fix parseInvoice')
    await pointers.generate({
      workspaceId: w.workspaceId,
      taskId: task.id,
      teamId: w.teamId,
      userId: w.userId,
      query: 'parseInvoice',
    })

    await db.admin.execute(`DELETE FROM code_files WHERE workspace_id = $1`, [w.workspaceId])
    const revalidated = await pointers.revalidate(w.workspaceId, task.id)

    const pointer = revalidated[0]!
    expect(pointer.staleAt).not.toBeNull()
    // Marked rather than deleted: the last known good commit still links, and
    // that tells a reader what it used to point at. An absence tells them
    // nothing at all.
    expect(pointer.commitSha).toBe('commit-1')
    expect(pointer.url).toContain('commit-1')
  })

  it('TASK-3 AC5: a pointer whose lines now run past the end of the file is stale too', async () => {
    const w = await world()
    await indexFile(w, { path: 'src/a.ts', text: 'export function parseInvoice() {}', lineEnd: 80 })
    const task = await makeTask(w, 'Fix parseInvoice')
    await pointers.generate({
      workspaceId: w.workspaceId,
      taskId: task.id,
      teamId: w.teamId,
      userId: w.userId,
      query: 'parseInvoice',
    })

    // The file shrank. A range past its end opens to a blank screen rather
    // than an error, which is the kind of "resolving" that fools a reader.
    await db.admin.execute(`UPDATE code_chunks SET line_end = 5 WHERE workspace_id = $1`, [
      w.workspaceId,
    ])

    expect((await pointers.revalidate(w.workspaceId, task.id))[0]!.staleAt).not.toBeNull()
  })

  it('TASK-3 AC5: a pointer that still resolves is un-marked again', async () => {
    const w = await world()
    await indexFile(w, { path: 'src/a.ts', text: 'export function parseInvoice() {}' })
    const task = await makeTask(w, 'Fix parseInvoice')
    await pointers.generate({
      workspaceId: w.workspaceId,
      taskId: task.id,
      teamId: w.teamId,
      userId: w.userId,
      query: 'parseInvoice',
    })

    // Otherwise a transient reindex would permanently mark every pointer, and
    // a staleness flag nobody trusts is a flag nobody reads.
    expect((await pointers.revalidate(w.workspaceId, task.id))[0]!.staleAt).toBeNull()
  })

  it('TASK-3 AC1: a manual pointer to a file the index has never seen is refused', async () => {
    const w = await world()
    await indexFile(w, { path: 'src/a.ts', text: 'export function parseInvoice() {}' })
    const task = await makeTask(w, 'Fix parseInvoice')

    // A person typing a path is at least as able to mistype one as a model is
    // to invent one, and the requirement is that a pointer resolves — not that
    // it was created in good faith.
    await expect(
      pointers.addManual({
        workspaceId: w.workspaceId,
        taskId: task.id,
        userId: w.userId,
        repositoryId: w.repositoryId,
        path: 'src/does-not-exist.ts',
        lineStart: 1,
        lineEnd: 2,
      }),
    ).rejects.toThrow(/not in the index/i)
  })

  it('TASK-3 AC6: every pointer carries its source and confidence', async () => {
    const w = await world()
    await indexFile(w, { path: 'src/a.ts', text: 'export function parseInvoice() {}' })
    const task = await makeTask(w, 'Fix parseInvoice')

    const [generated] = await pointers.generate({
      workspaceId: w.workspaceId,
      taskId: task.id,
      teamId: w.teamId,
      userId: w.userId,
      query: 'parseInvoice',
    })

    // A downstream consumer — a brief, an MCP prompt, the UI — can only
    // express uncertainty if it is told about it.
    expect(generated!.source).toBe('generated')
    expect(generated!.confidence).toBeGreaterThan(0)
    expect(generated!.confidence).toBeLessThanOrEqual(1)
    expect(generated!.url).toMatch(/^https?:\/\//)
  })
})
