import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createIsolatedDatabase, withTenant, type IsolatedDatabase } from '@chorus/db'
import { ulid } from '@chorus/core'
import { createFakeModelProvider, type FakeModelProvider } from '@chorus/testing'
import { VECTOR_SEARCH_SQL } from '../../src/index.js'

/**
 * BRAIN-4 AC5 — retrieval is served by its indexes, at any corpus size.
 *
 * §24 budgets retrieval at < 300 ms p95 over a million chunks. No test that
 * runs in a pull request can hold a million chunks, and no timing threshold
 * over a small one means anything: an index lookup and a scan are a few
 * milliseconds apart at two thousand rows and a hundredfold apart at a million.
 *
 * What *is* assertable cheaply is the property the budget actually rests on —
 * **how much of the corpus a search reads**. An index lookup reads its
 * candidate list; a scan reads everything. That distinction is visible in the
 * plan at any size, it is what makes the budget survive the corpus growing, and
 * it is the thing that has broken twice.
 *
 * This asserts against the exported query strings the retriever runs, not
 * against a copy of them. #155 is why: the nightly suite EXPLAINed a
 * hand-written copy that omitted the `code_files` join, reported the HNSW index
 * as reached, and was right about the string it was given and wrong about the
 * system. The real query drove from files and nested-loop scanned every chunk —
 * 121 ms at 20k chunks where the copy measured 2.5 ms — and the arithmetic in
 * #155 never closed because the fast query was never the one being run.
 */
describe('BRAIN-4 AC5 retrieval query plans', () => {
  let db: IsolatedDatabase
  let models: FakeModelProvider
  let workspaceId: string
  let repositoryId: string

  /**
   * Enough rows that reading all of them is unmistakable in the plan, few
   * enough to seed inside the integration budget. The assertion is a ratio
   * against this number, not an absolute, so it stays meaningful if it changes.
   */
  const CHUNKS = 2_000
  const CANDIDATES = 50

  /**
   * Every row of `code_chunks` the executor actually looked at.
   *
   * Rows removed by a filter count. A sequential scan that reads the whole
   * table and returns five rows reports `Actual Rows: 5`, so counting only
   * output rows would score the most expensive plan available as the cheapest.
   */
  function chunkRowsRead(node: Record<string, any>): number {
    const loops = Number(node['Actual Loops'] ?? 1)
    const examined =
      Number(node['Actual Rows'] ?? 0) +
      Number(node['Rows Removed by Filter'] ?? 0) +
      Number(node['Rows Removed by Index Recheck'] ?? 0)
    const self = node['Relation Name'] === 'code_chunks' ? examined * loops : 0
    const children: Record<string, any>[] = node['Plans'] ?? []
    return self + children.reduce((total, child) => total + chunkRowsRead(child), 0)
  }

  /**
   * The plan as a few readable lines.
   *
   * The raw JSON carries the query vector, so a failure message built from it
   * is fifteen hundred zeroes wide and unreadable in a CI log — which is the
   * moment the message matters most.
   */
  function outline(node: Record<string, any>, depth = 0): string[] {
    const what = [node['Node Type'], node['Index Name'] ?? node['Relation Name']]
      .filter(Boolean)
      .join(' ')
    const rows = `rows=${node['Actual Rows'] ?? '?'}×${node['Actual Loops'] ?? 1}`
    const estimate = node['Plan Rows'] === undefined ? '' : ` (estimated ${node['Plan Rows']})`
    return [
      `${'  '.repeat(depth)}${what} ${rows}${estimate}`,
      ...((node['Plans'] ?? []) as Record<string, any>[]).flatMap((child) =>
        outline(child, depth + 1),
      ),
    ]
  }

  async function planFor(
    sql: string,
    params: unknown[],
  ): Promise<{ indexes: string; shape: string; read: number }> {
    return withTenant(
      workspaceId,
      async (t) => {
        const rows = await t.query<Record<string, unknown>>(
          `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
          params,
        )
        const plan = (Object.values(rows[0]!)[0] as any[])[0]
        const indexes: string[] = []
        const walk = (node: Record<string, any>): void => {
          if (node['Index Name']) indexes.push(String(node['Index Name']))
          for (const child of (node['Plans'] ?? []) as Record<string, any>[]) walk(child)
        }
        walk(plan['Plan'])
        return {
          indexes: indexes.join(','),
          shape: outline(plan['Plan']).join('\n'),
          read: chunkRowsRead(plan['Plan']),
        }
      },
      { config: db.config },
    )
  }

  /** How many chunks have been seeded so far, so `grow` can extend the corpus. */
  let seeded = 0

  /**
   * Adds chunks until the corpus holds `to` of them.
   *
   * Several files rather than one, in batches: the defect this file guards
   * against is the planner driving the query from `code_files`, which a
   * single-file corpus hides entirely.
   */
  async function grow(to: number): Promise<void> {
    const BATCH = 500
    for (; seeded < to; seeded += BATCH) {
      const fileId = ulid()
      await db.admin.execute(
        `INSERT INTO code_files (id, workspace_id, repository_id, path, lang, content_hash)
         VALUES ($1, $2, $3, $4, 'ts', $5)`,
        [fileId, workspaceId, repositoryId, `src/generated/f${seeded}.ts`, ulid()],
      )
      const values: string[] = []
      const params: unknown[] = []
      for (let i = 0; i < BATCH; i += 1) {
        const n = seeded + i
        const text = `export function handler${n}() { /* symbol${n % 400} return const value */ }`
        const b = params.length
        values.push(
          `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, 1, 10, $${b + 6}, $${b + 7}::vector)`,
        )
        params.push(
          ulid(),
          workspaceId,
          repositoryId,
          fileId,
          text,
          `handler${n}`,
          `[${models.embedText(text).join(',')}]`,
        )
      }
      await db.admin.execute(
        `INSERT INTO code_chunks
           (id, workspace_id, repository_id, file_id, text, line_start, line_end, symbol_name, embedding)
         VALUES ${values.join(', ')}`,
        params,
      )
    }
    await db.admin.execute(`ANALYZE code_chunks`)
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    models = createFakeModelProvider()

    workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    const [repo] = await db.admin.query<{ id: string }>(
      `SELECT id FROM repositories WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    repositoryId = repo!.id

    await db.admin.execute(`DELETE FROM code_chunks WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM code_files WHERE workspace_id = $1`, [workspaceId])

    await grow(CHUNKS)
    // `code_chunks` is analysed and `code_files` deliberately is not, because
    // that is the state a repository is in the moment it finishes indexing:
    // rows inserted, autovacuum not yet round. Retrieval has to work then —
    // it is the most likely moment for somebody to ask their first question.
    //
    // It is also the state that exposes #155. With statistics on `code_files`
    // the planner estimates the join correctly and both shapes of this query
    // reach the HNSW index; without them it estimates one file, chooses a
    // nested loop, and the shape that joins inside the ranked subquery scans
    // every chunk of every file instead. Measured at 20k chunks: 347ms against
    // 4.5ms. A plan that is only correct when statistics are fresh is not a
    // plan, it is a coincidence.
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('BRAIN-4 AC5: the vector search is served by the HNSW index, not by scanning the corpus', async () => {
    const embedding = models.embedText('symbol7 return')
    const { indexes, shape, read } = await planFor(VECTOR_SEARCH_SQL, [
      `[${embedding.join(',')}]`,
      [repositoryId],
      CANDIDATES,
      0.6,
    ])

    expect(
      indexes,
      `the vector search did not reach code_chunks_embedding; it used [${indexes}]:\n${shape}`,
    ).toContain('code_chunks_embedding')

    // The real assertion. Reaching *an* index is not the same as being served
    // by the right one: the plan that caused #155 also used an index —
    // `code_chunks_by_file`, once per file, for every chunk in it.
    expect(
      read,
      `the vector search read ${read} of ${CHUNKS} chunks; an index lookup reads its candidates, ` +
        `a scan reads the corpus, and only the first still fits the budget at a million rows:\n${shape}`,
    ).toBeLessThanOrEqual(CANDIDATES * 4)
  })

  it('BRAIN-4 AC5: the vector search stays on the index as the corpus grows', async () => {
    // The defect this file exists for was invisible below about two thousand
    // chunks and total above it, so "it was fine when I checked" was true and
    // useless. Growing the corpus inside one test states the property that
    // actually matters — the work does not follow the corpus — rather than
    // trusting that whatever size someone picked is the size that bites.
    const embedding = `[${models.embedText('symbol7 return').join(',')}]`
    const at = async (): Promise<number> =>
      (await planFor(VECTOR_SEARCH_SQL, [embedding, [repositoryId], CANDIDATES, 0.6])).read

    const before = await at()
    await grow(CHUNKS * 2)
    const after = await at()

    expect(
      after,
      `doubling the corpus took the vector search from ${before} rows to ${after}; ` +
        `an index lookup is flat in the corpus and a scan is linear in it, and §24 budgets ` +
        `a million chunks`,
    ).toBeLessThanOrEqual(CANDIDATES * 4)
  })
})
