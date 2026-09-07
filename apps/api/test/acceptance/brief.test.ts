import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createBriefBuilder } from '@chorus/coding'

/**
 * CODE-2 — the brief, and the reason there is only one builder.
 *
 * > The brief is the entire difference between an agent that edits the right
 * > three files and one that wanders the repository.
 *
 * AC2 is the assertion this suite exists for. The platform's sandbox and an
 * engineer's own agent over MCP must receive **identical** context, and the
 * only way that stays true is a test that compares them directly. Drift here is
 * invisible: nothing fails, nobody sees a stack trace, and six months later
 * somebody mentions in passing that the CLI gives worse results than the web
 * app and nobody can say when that started.
 *
 * It is written now, before either consumer exists, deliberately — `plan.md`
 * §2.3 pulled CODE-2 into Phase 1 precisely so the sandbox is built against an
 * already-tested contract rather than the contract being written to describe
 * whatever the sandbox turned out to do.
 */
describe('CODE-2 brief assembly', () => {
  let db: IsolatedDatabase

  interface World {
    workspaceId: string
    teamId: string
    userId: string
    repositoryId: string
    taskId: string
  }

  /** A task with every declared source category populated. */
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

    const userId = member!.user_id
    const teamId = team!.id
    const repositoryId = repo!.id

    await db.admin.execute(`UPDATE teams SET charter = $2 WHERE id = $1`, [
      teamId,
      'We ship small changes and we write the test first.',
    ])

    // AC6: the exact commands, as the indexer detected them.
    await db.admin.execute(
      `UPDATE repositories
          SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb,
              full_name = 'acme/billing'
        WHERE id = $1`,
      [
        repositoryId,
        JSON.stringify({
          framework: 'next',
          conventions: {
            packageManager: 'pnpm',
            testCommand: 'pnpm run test',
            lintCommand: 'pnpm run lint',
            formatCommand: null,
            buildCommand: 'pnpm run build',
            contributionGuide: 'CONTRIBUTING.md',
            agentInstructions: ['AGENTS.md'],
            monorepo: ['packages/*'],
          },
        }),
      ],
    )

    const taskId = ulid()
    // The seed already uses CH-1; a key unique to this world keeps each test's
    // workspace independent, which is what makes the suite parallel-safe.
    const key = `CH-${taskId.slice(-6)}`
    await db.admin.execute(
      `INSERT INTO tasks (id, workspace_id, team_id, key, title, description,
                          acceptance_criteria, created_by)
       VALUES ($1, $2, $3, $8, $4, $5, $6, $7)`,
      [
        taskId,
        workspaceId,
        teamId,
        'Split the invoice parser',
        JSON.stringify({ text: 'parseInvoice does three jobs and should do one.' }),
        JSON.stringify([
          { id: 'ac1', text: 'Parsing is separated from validation', checked: false },
          { id: 'ac2', text: 'Posting moves behind its own interface', checked: false },
        ]),
        userId,
        key,
      ],
    )

    // A linked document, through the artefact-link table the product uses.
    const documentId = ulid()
    await db.admin.execute(
      `INSERT INTO documents (id, workspace_id, team_id, title, type, sections, created_by)
       VALUES ($1, $2, $3, 'Billing rework', 'prd', $4, $5)`,
      [
        documentId,
        workspaceId,
        teamId,
        JSON.stringify([
          {
            key: 'summary',
            title: 'Summary',
            guidance: '',
            required: true,
            content: 'The parser is three responsibilities in one function.',
          },
        ]),
        userId,
      ],
    )
    await db.admin.execute(
      `INSERT INTO artefact_links
         (id, workspace_id, from_type, from_id, to_type, to_id, relation, created_by)
       VALUES ($1, $2, 'task', $3, 'document', $4, 'derived_from', $5)`,
      [ulid(), workspaceId, taskId, documentId, userId],
    )

    // A file to point at, and a pointer to it.
    const fileId = ulid()
    await db.admin.execute(
      `INSERT INTO code_files (id, workspace_id, repository_id, path, lang, content_hash, commit_sha)
       VALUES ($1, $2, $3, 'src/billing/parse.ts', 'ts', $4, 'commit-1')`,
      [fileId, workspaceId, repositoryId, ulid()],
    )
    await db.admin.execute(
      `INSERT INTO code_pointers
         (id, workspace_id, task_id, repository_id, path, symbol_name,
          line_start, line_end, commit_sha, source, confidence)
       VALUES ($1, $2, $3, $4, 'src/billing/parse.ts', 'parseInvoice', 1, 40, 'commit-1',
               'generated', 0.9)`,
      [ulid(), workspaceId, taskId, repositoryId],
    )

    return { workspaceId, teamId, userId, repositoryId, taskId }
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('CODE-2 AC1: a brief for a fully-populated task contains every declared source category', async () => {
    // Given a task with criteria, a linked document, pointers and conventions
    const w = await world()
    const builder = createBriefBuilder(db.config)

    // When the brief is built
    const brief = await builder.forTask(w.workspaceId, w.taskId)

    // Then every category §12.1 declares is present and delineated
    expect(brief.markdown).toContain('We ship small changes')
    expect(brief.markdown).toContain('pnpm run test')
    expect(brief.markdown).toContain('Billing rework')
    expect(brief.markdown).toContain('Split the invoice parser')
    expect(brief.markdown).toContain('Parsing is separated from validation')
    expect(brief.markdown).toContain('src/billing/parse.ts')

    // and structurally present in brief.json, so an adapter that prefers
    // structure is not made to scrape the Markdown it was given instead.
    expect(brief.json.charter).toContain('We ship small changes')
    expect(brief.json.conventions.testCommand).toBe('pnpm run test')
    expect(brief.json.documents).toHaveLength(1)
    expect(brief.json.task.acceptanceCriteria).toHaveLength(2)
    expect(brief.json.pointers).toHaveLength(1)
    // Absent sources are present and empty, not missing: an adapter should not
    // have to distinguish "no decisions" from "this builder forgot decisions".
    expect(brief.json.decisions).toEqual([])
    expect(brief.json.captures).toEqual([])
  })

  it('CODE-2 AC2: the sandbox brief and the MCP implement-task prompt are byte-identical', async () => {
    // Given one task
    const w = await world()
    const builder = createBriefBuilder(db.config)

    // When a brief is built for a sandbox job, and for the MCP prompt
    const sandbox = await builder.forSandbox(w.workspaceId, w.taskId)
    const mcp = await builder.forMcpPrompt(w.workspaceId, w.taskId)

    // Then they are identical — compared directly, not inspected. This is the
    // whole of ADR-0007 made real: an engineer's own agent is not briefed worse
    // than the platform's.
    expect(mcp).toBe(sandbox)
    expect(sandbox.length).toBeGreaterThan(0)
  })

  it('CODE-2 AC6: the exact commands appear, so nothing has to be guessed', async () => {
    // Given a repository whose conventions the indexer detected
    const w = await world()
    const builder = createBriefBuilder(db.config)

    // When the brief is built
    const brief = await builder.forTask(w.workspaceId, w.taskId)

    // Then the commands are quoted verbatim. An agent that has to guess between
    // `npm test` and `pnpm run test` gets it wrong in a container with no
    // network and reports a failure that is its own.
    expect(brief.markdown).toContain('pnpm run test')
    expect(brief.markdown).toContain('pnpm run lint')
    expect(brief.markdown).toContain('pnpm run build')
    expect(brief.markdown).toContain('AGENTS.md')
  })

  it('CODE-2 AC3: the same inputs produce a byte-identical brief and a stable hash', async () => {
    // Given unchanged inputs
    const w = await world()
    const builder = createBriefBuilder(db.config)

    // When the brief is built twice
    const first = await builder.forTask(w.workspaceId, w.taskId)
    const second = await builder.forTask(w.workspaceId, w.taskId)

    // Then the bytes and the hash agree. A hash that moved on its own would
    // make caching wrong and make a trace's brief reference meaningless.
    expect(second.markdown).toBe(first.markdown)
    expect(second.hash).toBe(first.hash)
  })

  it('CODE-2 AC5: a stale pointer is flagged, never presented as current fact', async () => {
    // Given a pointer the index has since marked stale
    const w = await world()
    await db.admin.execute(
      `UPDATE code_pointers SET stale_at = now() WHERE task_id = $1`,
      [w.taskId],
    )
    const builder = createBriefBuilder(db.config)

    // When the brief is built
    const brief = await builder.forTask(w.workspaceId, w.taskId)

    // Then it is not offered as a current location. A stale pointer presented
    // as fact is worse than no pointer: the agent goes to the named line,
    // finds something else, and reasons from it.
    const [pointer] = brief.json.pointers
    if (pointer) {
      expect(pointer.stale).toBe(true)
      expect(brief.markdown).toMatch(/stale/i)
    } else {
      expect(brief.markdown).not.toContain('src/billing/parse.ts')
    }
  })
})
