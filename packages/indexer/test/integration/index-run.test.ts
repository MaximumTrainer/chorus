import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid } from '@chorus/core'
import { createIndexer, type Indexer } from '../../src/index-run.js'

/**
 * BRAIN-2 AC1, AC2, AC7 — indexing a working copy into the database.
 *
 * The two properties only a database can show:
 *
 *  - **The index reports the commit it represents.** A citation drawn from an
 *    index nobody can date is one nobody can trust, because there is no way to
 *    tell whether the line it names still says what it said.
 *  - **A re-index touches only what changed.** Not an optimisation: a full
 *    re-embed on every push is the difference between a repository that stays
 *    current and one whose index is always an hour behind and expensive.
 */
describe('BRAIN-2 index run', () => {
  let db: IsolatedDatabase
  let indexer: Indexer
  let embedCalls = 0

  /**
   * A deterministic stand-in for the embedding provider.
   *
   * Never a real model (CLAUDE.md §4). Counting calls is how "only what changed
   * was re-embedded" becomes observable rather than asserted about counts the
   * indexer reports about itself.
   */
  const embed = async (texts: readonly string[]): Promise<number[][]> => {
    embedCalls += texts.length
    return texts.map((text) => {
      const vector = new Array<number>(1536).fill(0)
      for (let index = 0; index < text.length; index++) {
        vector[index % 1536] = (vector[index % 1536]! + text.charCodeAt(index)) % 97
      }
      return vector
    })
  }

  function repository(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'chorus-index-'))
    write(root, files)
    return root
  }

  function write(root: string, files: Record<string, string>): void {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, contents, 'utf8')
    }
  }

  async function linked(): Promise<{ workspaceId: string; repositoryId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    const [repository] = await db.admin.query<{ id: string }>(
      `SELECT id FROM repositories WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    // The seeded index rows exist so the tenancy suite has something to try to
    // read across the boundary; this suite counts rows, so they go.
    await db.admin.execute(`DELETE FROM code_chunks WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM code_symbols WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM code_imports WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM code_files WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM repo_index_runs WHERE workspace_id = $1`, [workspaceId])
    return { workspaceId, repositoryId: repository!.id }
  }

  const filesIn = (workspaceId: string) =>
    db.admin.query<{ path: string; lang: string | null; content_hash: string; parse_error: string | null }>(
      `SELECT path, lang, content_hash, parse_error FROM code_files WHERE workspace_id = $1 ORDER BY path`,
      [workspaceId],
    )

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    indexer = await createIndexer(db.config, { embed, embeddingModel: 'fake-embed-v1' })
  }, 180_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('BRAIN-2 AC1: a repository indexes end to end and reports its commit', async () => {
    const { workspaceId, repositoryId } = await linked()
    const root = repository({
      'src/widget.ts': [
        `import { readFile } from 'node:fs/promises'`,
        ``,
        `export interface Widget {`,
        `  id: string`,
        `}`,
        ``,
        `export function makeWidget(id: string): Widget {`,
        `  return { id }`,
        `}`,
      ].join('\n'),
      'README.md': '# Widgets\n\nA library.\n',
    })

    try {
      const run = await indexer.index({
        workspaceId,
        repositoryId,
        workingCopy: root,
        commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      })

      expect(run.status).toBe('succeeded')
      expect(run.commitSha).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')

      // Files, with the language that was detected.
      const files = await filesIn(workspaceId)
      expect(files.map((file) => file.path)).toEqual(['README.md', 'src/widget.ts'])
      expect(files.find((f) => f.path === 'src/widget.ts')!.lang).toBe('typescript')
      // Markdown has no grammar; that is not a failure, so no error is recorded.
      expect(files.find((f) => f.path === 'README.md')!.lang).toBeNull()

      const symbols = await db.admin.query<{ name: string; line_start: number }>(
        `SELECT name, line_start FROM code_symbols WHERE workspace_id = $1`,
        [workspaceId],
      )
      // Compared as a set: the order rows come back in is the database's
      // collation, which is not what this test is about.
      expect(new Set(symbols.map((symbol) => symbol.name))).toEqual(
        new Set(['Widget', 'makeWidget']),
      )
      expect(symbols.find((s) => s.name === 'makeWidget')!.line_start).toBe(7)

      const imports = await db.admin.query<{ specifier: string }>(
        `SELECT specifier FROM code_imports WHERE workspace_id = $1`,
        [workspaceId],
      )
      expect(imports.map((row) => row.specifier)).toContain('node:fs/promises')

      // Chunks, each with an embedding and a line range a reader could open.
      const chunks = await db.admin.query<{ line_start: number; line_end: number; embedding: unknown }>(
        `SELECT line_start, line_end, embedding FROM code_chunks WHERE workspace_id = $1`,
        [workspaceId],
      )
      expect(chunks.length).toBeGreaterThan(0)
      for (const chunk of chunks) {
        expect(chunk.line_start).toBeGreaterThanOrEqual(1)
        expect(chunk.line_end).toBeGreaterThanOrEqual(chunk.line_start)
        expect(chunk.embedding, 'a chunk with no vector is unretrievable').not.toBeNull()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('BRAIN-2 AC2: a re-index of an unchanged repository re-embeds nothing', async () => {
    const { workspaceId, repositoryId } = await linked()
    const root = repository({ 'src/a.ts': 'export function alpha() { return 1 }\n' })

    try {
      await indexer.index({ workspaceId, repositoryId, workingCopy: root, commitSha: 'commit-1' })

      embedCalls = 0
      const second = await indexer.index({
        workspaceId,
        repositoryId,
        workingCopy: root,
        commitSha: 'commit-2',
      })

      // Counted at the provider, not taken from the indexer's own report: a
      // stat can say "0 re-embedded" while the calls happen anyway.
      expect(embedCalls, 'an unchanged file must not be re-embedded').toBe(0)
      expect(second.stats.filesUnchanged).toBe(1)
      expect(second.stats.filesIndexed).toBe(0)
      // The run still records the newer commit: the index is current, it just
      // had nothing to do.
      expect(second.commitSha).toBe('commit-2')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('BRAIN-2 AC2: a push changing one file re-indexes only that file', async () => {
    const { workspaceId, repositoryId } = await linked()
    const root = repository({
      'src/a.ts': 'export function alpha() { return 1 }\n',
      'src/b.ts': 'export function beta() { return 2 }\n',
      'src/c.ts': 'export function gamma() { return 3 }\n',
    })

    try {
      await indexer.index({ workspaceId, repositoryId, workingCopy: root, commitSha: 'commit-1' })
      const before = await db.admin.query<{ id: string; path: string }>(
        `SELECT id, path FROM code_files WHERE workspace_id = $1 ORDER BY path`,
        [workspaceId],
      )

      write(root, { 'src/b.ts': 'export function beta() { return 22 }\n' })
      embedCalls = 0
      const run = await indexer.index({
        workspaceId,
        repositoryId,
        workingCopy: root,
        commitSha: 'commit-2',
      })

      expect(run.stats.filesIndexed).toBe(1)
      expect(run.stats.filesUnchanged).toBe(2)
      expect(embedCalls).toBeGreaterThan(0)

      // The untouched files keep their rows — same ids — so anything pointing
      // at them still resolves.
      const after = await db.admin.query<{ id: string; path: string }>(
        `SELECT id, path FROM code_files WHERE workspace_id = $1 ORDER BY path`,
        [workspaceId],
      )
      expect(after.find((f) => f.path === 'src/a.ts')!.id).toBe(
        before.find((f) => f.path === 'src/a.ts')!.id,
      )

      const symbols = await db.admin.query<{ name: string }>(
        `SELECT s.name FROM code_symbols s
           JOIN code_files f ON f.id = s.file_id
          WHERE f.path = 'src/b.ts' AND s.workspace_id = $1`,
        [workspaceId],
      )
      // Re-parsed, not appended to: the old symbols for that file are gone.
      expect(symbols.map((s) => s.name)).toEqual(['beta'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('BRAIN-2 AC2: a deleted file leaves the index, along with its chunks', async () => {
    const { workspaceId, repositoryId } = await linked()
    const root = repository({
      'src/a.ts': 'export function alpha() { return 1 }\n',
      'src/gone.ts': 'export function gone() { return 0 }\n',
    })

    try {
      await indexer.index({ workspaceId, repositoryId, workingCopy: root, commitSha: 'commit-1' })
      rmSync(join(root, 'src/gone.ts'))

      const run = await indexer.index({
        workspaceId,
        repositoryId,
        workingCopy: root,
        commitSha: 'commit-2',
      })

      expect(run.stats.filesRemoved).toBe(1)
      expect((await filesIn(workspaceId)).map((file) => file.path)).toEqual(['src/a.ts'])
      // A chunk surviving its file is a citation pointing at code that is gone.
      const orphans = await db.admin.query(
        `SELECT 1 FROM code_chunks c LEFT JOIN code_files f ON f.id = c.file_id
          WHERE c.workspace_id = $1 AND f.id IS NULL`,
        [workspaceId],
      )
      expect(orphans).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('BRAIN-2 AC7: a file that will not parse is skipped with a reason, and the run completes', async () => {
    const { workspaceId, repositoryId } = await linked()
    const root = repository({
      'src/good.ts': 'export function good() { return 1 }\n',
      'src/broken.ts': 'export function ( { [ unterminated\n',
    })

    try {
      const run = await indexer.index({
        workspaceId,
        repositoryId,
        workingCopy: root,
        commitSha: 'commit-1',
      })

      // The run succeeds. One unparseable file must not cost the whole index —
      // every repository has generated or vendored code somewhere.
      expect(run.status).toBe('succeeded')
      expect(run.failures).toHaveLength(1)
      expect(run.failures[0]!.path).toBe('src/broken.ts')
      expect(run.failures[0]!.reason).toBeTruthy()

      // The file is still indexed and chunked — retrievable as text, just with
      // no structure claimed for it.
      const broken = (await filesIn(workspaceId)).find((f) => f.path === 'src/broken.ts')!
      expect(broken.parse_error).toBeTruthy()
      const chunks = await db.admin.query(
        `SELECT 1 FROM code_chunks c JOIN code_files f ON f.id = c.file_id
          WHERE f.path = 'src/broken.ts' AND c.workspace_id = $1`,
        [workspaceId],
      )
      expect(chunks.length).toBeGreaterThan(0)

      // And the good file is fully indexed regardless.
      const symbols = await db.admin.query<{ name: string }>(
        `SELECT name FROM code_symbols WHERE workspace_id = $1`,
        [workspaceId],
      )
      expect(symbols.map((s) => s.name)).toEqual(['good'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('BRAIN-2 AC5: an ignored secret reaches neither the index nor the embeddings', async () => {
    const { workspaceId, repositoryId } = await linked()
    const root = repository({
      '.gitignore': '.env\nsecrets/\n',
      '.env': 'DATABASE_PASSWORD=hunter2\n',
      'secrets/token.txt': 'ghp_arealsecret\n',
      'src/a.ts': 'export function alpha() { return 1 }\n',
    })

    try {
      await indexer.index({ workspaceId, repositoryId, workingCopy: root, commitSha: 'commit-1' })

      const everything = JSON.stringify([
        await db.admin.query(`SELECT * FROM code_files WHERE workspace_id = $1`, [workspaceId]),
        await db.admin.query(`SELECT * FROM code_chunks WHERE workspace_id = $1`, [workspaceId]),
      ])
      // Asserted over the stored rows rather than over the walk, because the
      // criterion is about what ends up in the index — including the chunk text
      // that gets embedded.
      expect(everything).not.toContain('hunter2')
      expect(everything).not.toContain('ghp_arealsecret')
      expect(everything).not.toContain('secrets/token.txt')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('BRAIN-2: one repository’s index is invisible to another workspace', async () => {
    const mine = await linked()
    const theirs = await linked()
    const root = repository({ 'src/a.ts': 'export function alpha() { return 1 }\n' })

    try {
      await indexer.index({ ...mine, workingCopy: root, commitSha: 'commit-1' })
      expect(await filesIn(theirs.workspaceId)).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('BRAIN-2 AC1: an index run is recorded even when it fails', async () => {
    const { workspaceId, repositoryId } = await linked()

    // A working copy that is not there at all. The run must be recorded as
    // failed rather than vanishing, or "why is this repository not indexed"
    // has no answer.
    await expect(
      indexer.index({
        workspaceId,
        repositoryId,
        workingCopy: join(tmpdir(), `chorus-missing-${ulid()}`),
        commitSha: 'commit-1',
      }),
    ).rejects.toThrow()

    const [run] = await db.admin.query<{ status: string }>(
      `SELECT status FROM repo_index_runs WHERE workspace_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [workspaceId],
    )
    expect(run!.status).toBe('failed')
  })
})
