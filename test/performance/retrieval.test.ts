import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { cpus, totalmem } from 'node:os'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid } from '@chorus/core'
import { createRetriever, type Retriever } from '@chorus/brain'
import { createFakeModelProvider, type FakeModelProvider } from '@chorus/testing'

/**
 * BRAIN-4 AC5 / NFR-7 — retrieval latency against the §24 budget.
 *
 * > Retrieval | < 300 ms p95 over 1M chunks
 *
 * The honesty problem here is different from the indexing benchmark's. Indexing
 * throughput scales roughly linearly, so a small corpus extrapolates. Retrieval
 * latency should *not* scale linearly — that is the entire point of having
 * indexes — so measuring at 20k chunks and multiplying would be meaningless in
 * one direction and dishonest in the other.
 *
 * So this measures two things:
 *
 *  1. **Absolute p95 at the corpus size it ran**, against the budget. Necessary,
 *     not sufficient: passing at 20k says nothing about 1M on its own.
 *  2. **That both searches are served by their indexes**, asserted on the query
 *     plan rather than inferred from timings. A scan and an index lookup are a
 *     few milliseconds apart at twenty thousand rows and a hundredfold apart at
 *     a million, so no timing threshold cheap enough to run in a minute can
 *     tell them apart — but the planner will say so directly. Every defect
 *     found while writing this was of exactly that kind: SQL written so the
 *     planner could not reach an index.
 *
 * `CHORUS_RETRIEVAL_CHUNKS=1000000` runs the real thing, nightly.
 */

/** §24. */
const BUDGET_P95_MS = 300

/** Enough for the index to matter; small enough to run in a minute. */
const CHUNKS = Number(process.env.CHORUS_RETRIEVAL_CHUNKS ?? 20_000)

/**
 * A vocabulary shaped like real code, which matters more than it sounds.
 *
 * The first version of this drew every chunk from sixteen words, so a
 * three-term query matched most of the table and the benchmark measured
 * ranking a hundred thousand rows rather than finding a handful. Real code
 * search is the opposite: a large vocabulary, heavily skewed, where a specific
 * query matches a small fraction. A corpus that does not have that shape
 * produces a number that is pessimistic in a way nobody can interpret.
 */
const COMMON = [
  'return',
  'const',
  'async',
  'error',
  'value',
  'result',
  'options',
  'context',
]

/** The terms a person would actually search for, spread thinly. */
const RARE = Array.from({ length: 400 }, (_, i) => `symbol${i}`)

/** Deterministic: the same corpus every run, so a regression is a regression. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

describe('BRAIN-4 AC5 retrieval latency', () => {
  let db: IsolatedDatabase
  let models: FakeModelProvider
  let retriever: Retriever
  let workspaceId: string
  let userId: string
  let teamId: string
  let repositoryId: string

  /** Inserts `count` chunks, in batches, with real embeddings. */
  async function seedChunks(count: number, offset: number): Promise<void> {
    const random = seeded(count + offset)
    const BATCH = 500

    for (let start = 0; start < count; start += BATCH) {
      const size = Math.min(BATCH, count - start)
      const fileId = ulid()
      await db.admin.execute(
        `INSERT INTO code_files (id, workspace_id, repository_id, path, lang, content_hash)
         VALUES ($1, $2, $3, $4, 'ts', $5)`,
        [fileId, workspaceId, repositoryId, `src/generated/f${offset + start}.ts`, ulid()],
      )

      const values: string[] = []
      const params: unknown[] = []
      for (let i = 0; i < size; i += 1) {
        // Mostly common words, with a couple of rare ones — the distribution a
        // real corpus has, and the one that makes a specific query selective.
        const words = [
          ...Array.from({ length: 10 }, () => COMMON[Math.floor(random() * COMMON.length)]!),
          ...Array.from({ length: 2 }, () => RARE[Math.floor(random() * RARE.length)]!),
        ]
        const text = `export function handler${offset + start + i}() { /* ${words.join(' ')} */ }`
        const base = params.length
        values.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, 1, 10, $${base + 6}, $${base + 7}::vector)`,
        )
        params.push(
          ulid(),
          workspaceId,
          repositoryId,
          fileId,
          text,
          `handler${offset + start + i}`,
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
  }

  /** p95 over a fixed set of queries, each measured end to end. */
  async function measureP95(queries: readonly string[]): Promise<number> {
    const timings: number[] = []
    for (const query of queries) {
      const started = performance.now()
      await retriever.retrieve({ workspaceId, teamId, userId, query, k: 10 })
      timings.push(performance.now() - started)
    }
    timings.sort((a, b) => a - b)
    return timings[Math.min(timings.length - 1, Math.floor(timings.length * 0.95))]!
  }

  // What somebody actually types: a rare identifier, sometimes with a common
  // word beside it. Selective, which is the case an index exists to serve.
  const queries = Array.from({ length: 40 }, (_, i) => {
    const random = seeded(i + 1)
    const rare = RARE[Math.floor(random() * RARE.length)]!
    return random() < 0.5 ? rare : `${rare} ${COMMON[Math.floor(random() * COMMON.length)]!}`
  })

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    models = createFakeModelProvider()
    retriever = createRetriever(db.config, {
      models,
      embeddingModel: { provider: 'fake', model: 'fake-embed' },
    })

    workspaceId = ulid()
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
    userId = member!.user_id
    teamId = team!.id
    repositoryId = repo!.id

    await db.admin.execute(`DELETE FROM code_chunks WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM code_files WHERE workspace_id = $1`, [workspaceId])
  }, 900_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('BRAIN-4 AC5: both searches are served by their indexes, not by a scan', async () => {
    await seedChunks(CHUNKS, 0)
    await db.admin.execute(`ANALYZE code_chunks`)

    // Asserted on the *plan*, not inferred from timings. A scan and an index
    // lookup are only a few milliseconds apart at twenty thousand rows and a
    // hundredfold apart at a million, so a timing threshold small enough to run
    // in a minute cannot distinguish them — and four separate defects found
    // while writing this were all of exactly one kind: a query written so the
    // planner could not reach an index. That is a property of the SQL, and the
    // planner will state it directly if asked.
    const [repo] = await db.admin.query<{ id: string }>(
      `SELECT id FROM repositories WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    const embedding = `[${models.embedText(queries[0]!).join(',')}]`

    const vectorPlan = (
      await db.admin.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT c.id FROM code_chunks c
          WHERE c.repository_id = ANY($2) AND c.embedding IS NOT NULL
          ORDER BY c.embedding <=> $1::vector LIMIT 50`,
        [embedding, [repo!.id]],
      )
    )
      .map((row) => row['QUERY PLAN'])
      .join('\n')

    expect(
      vectorPlan,
      `the vector search fell back to a scan:\n${vectorPlan}`,
    ).toContain('code_chunks_embedding')

    const lexicalPlan = (
      await db.admin.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT c.id FROM code_chunks c
          WHERE c.repository_id = ANY($2) AND c.search @@ plainto_tsquery('simple', $1)
          ORDER BY ts_rank(c.search, plainto_tsquery('simple', $1)) DESC, c.id LIMIT 50`,
        [queries[0]!, [repo!.id]],
      )
    )
      .map((row) => row['QUERY PLAN'])
      .join('\n')

    expect(
      lexicalPlan,
      `the lexical search fell back to a scan:\n${lexicalPlan}`,
    ).toContain('code_chunks_search')
  })

  it('BRAIN-4 AC5: p95 is inside the §24 budget at the measured corpus size', async () => {
    const p95 = await measureP95(queries)

    console.log(
      JSON.stringify({
        benchmark: 'BRAIN-4 AC5 retrieval',
        // The budget is stated for a 4 vCPU / 8 GB reference host. A pass on a
        // developer's laptop is evidence retrieval is in the right order of
        // magnitude; only the nightly run on a known runner is evidence about
        // the reference host.
        host: { cpus: cpus().length, memoryGb: Math.round(totalmem() / 1024 ** 3) },
        chunks: CHUNKS,
        p95Ms: Number(p95.toFixed(1)),
      }),
    )

    // Necessary but not sufficient on its own — the growth check above is what
    // extends this to a corpus this test did not build.
    expect(
      p95,
      `p95 was ${p95.toFixed(0)}ms over ${CHUNKS} chunks, against a ${BUDGET_P95_MS}ms budget`,
    ).toBeLessThan(BUDGET_P95_MS)
  })

  it('BRAIN-4 AC5: a query matching nothing is not slower than one that matches', async () => {
    // The pathological case for a vector search with a distance ceiling: no
    // candidate clears it, so the scan has nothing to stop early for. If this
    // is materially slower, the ceiling has turned AC6's honesty into a way to
    // make the system slow by asking it a nonsense question.
    const matching = await measureP95(queries.slice(0, 10))
    const empty = await measureP95(
      Array.from({ length: 10 }, (_, i) => `zzqx${i} quantum chromodynamics lattice`),
    )

    expect(empty).toBeLessThan(Math.max(matching * 3, BUDGET_P95_MS))
  })
})
