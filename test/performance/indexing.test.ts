import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid } from '@chorus/core'
import { createIndexer, generateCorpus } from '@chorus/indexer'

/**
 * BRAIN-2 AC6 — indexing throughput against the §24 budget.
 *
 * > Repository index | 500k LOC in < 15 min on the reference host
 *
 * Three things this measurement is careful about, because a performance test
 * that is not careful is a number people stop believing:
 *
 *  1. **It measures the indexer's own work.** Embedding is stubbed. Embedding
 *     latency is a property of whichever model endpoint a deployment
 *     configured — it varies by orders of magnitude between a local model and a
 *     hosted one — so including it would measure someone else's system and call
 *     it ours. Walk, parse, chunk and persist are what BRAIN-2 owns.
 *  2. **It extrapolates honestly, and says so.** Generating and indexing the
 *     full 500k LOC on every run is minutes of wall-clock for a gate that
 *     should be cheap, so the default corpus is smaller and the result is
 *     scaled. `CHORUS_BENCHMARK_LINES` runs the real thing.
 *  3. **It reports the machine.** The budget is stated for a 4 vCPU / 8 GB
 *     reference host. A pass on a developer's laptop is evidence the indexer is
 *     in the right order of magnitude, and is *not* evidence the reference host
 *     meets the budget. Only the nightly run on a known runner is that.
 */

/** §24. */
const BUDGET_LINES = 500_000
const BUDGET_MS = 15 * 60 * 1000

/** Enough to be representative; small enough to run on every invocation. */
const DEFAULT_LINES = Number(process.env.CHORUS_BENCHMARK_LINES ?? 50_000)

describe('BRAIN-2 AC6 indexing throughput', () => {
  let db: IsolatedDatabase
  let corpusRoot: string

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    corpusRoot = mkdtempSync(join(tmpdir(), 'chorus-benchmark-'))
  }, 600_000)

  afterAll(async () => {
    await db?.drop()
    rmSync(corpusRoot, { recursive: true, force: true })
  })

  it('BRAIN-2 AC6: the benchmark corpus indexes within the §24 budget', async () => {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    const [repository] = await db.admin.query<{ id: string }>(
      `SELECT id FROM repositories WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    for (const table of ['route_map', 'code_chunks', 'code_symbols', 'code_imports', 'code_files']) {
      await db.admin.execute(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId])
    }

    const generatedAt = Date.now()
    const corpus = generateCorpus(join(corpusRoot, 'repo'), { targetLines: DEFAULT_LINES })
    const generationMs = Date.now() - generatedAt

    const indexer = await createIndexer(db.config, {
      // Stubbed deliberately — see the note above. A zero-cost embedder keeps
      // the measurement about the indexer.
      embed: async (texts) => texts.map(() => new Array<number>(1536).fill(0.01)),
      embeddingModel: 'benchmark-stub',
    })

    const startedAt = Date.now()
    const run = await indexer.index({
      workspaceId,
      repositoryId: repository!.id,
      workingCopy: corpus.path,
      commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    })
    const elapsedMs = Date.now() - startedAt

    expect(run.status).toBe('succeeded')

    const linesPerSecond = corpus.lines / (elapsedMs / 1000)
    const projectedMs = (BUDGET_LINES / corpus.lines) * elapsedMs

    // Reported, always, whether it passes or fails. A benchmark whose number is
    // only visible on failure cannot show a trend, and a trend is what catches
    // the regression that is still inside budget.
    console.warn(
      JSON.stringify(
        {
          level: 'info',
          message: 'BRAIN-2 AC6 indexing benchmark',
          host: { cpus: cpus().length, memoryGb: Math.round(totalmem() / 1024 ** 3) },
          corpus: { lines: corpus.lines, files: corpus.files, generationMs },
          measured: {
            elapsedMs,
            linesPerSecond: Math.round(linesPerSecond),
            filesIndexed: run.stats.filesIndexed,
            chunksWritten: run.stats.chunksWritten,
            symbolsWritten: run.stats.symbolsWritten,
            parseFailures: run.failures.length,
          },
          projectedFor500kLoc: { ms: Math.round(projectedMs), budgetMs: BUDGET_MS },
          note:
            'Embedding is stubbed: its latency belongs to the configured model endpoint, ' +
            'not to the indexer. Extrapolated from a smaller corpus unless ' +
            'CHORUS_BENCHMARK_LINES was set. Not measured on the reference host.',
        },
        null,
        2,
      ),
    )

    expect(projectedMs, `projected ${Math.round(projectedMs / 1000)}s for 500k LOC`).toBeLessThan(
      BUDGET_MS,
    )
  }, 900_000)

  it('BRAIN-2 AC6: an ignored directory costs nothing, however large', async () => {
    // The corpus contains a substantial `node_modules`. A walker that descended
    // into it would still pass the budget on a small corpus and fail on a real
    // repository, where vendored code outweighs source several times over.
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    const [repository] = await db.admin.query<{ id: string }>(
      `SELECT id FROM repositories WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    for (const table of ['route_map', 'code_chunks', 'code_symbols', 'code_imports', 'code_files']) {
      await db.admin.execute(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId])
    }

    const indexer = await createIndexer(db.config, {
      embed: async (texts) => texts.map(() => new Array<number>(1536).fill(0.01)),
      embeddingModel: 'benchmark-stub',
    })
    await indexer.index({
      workspaceId,
      repositoryId: repository!.id,
      workingCopy: join(corpusRoot, 'repo'),
      commitSha: 'commit-1',
    })

    const vendored = await db.admin.query(
      `SELECT 1 FROM code_files WHERE workspace_id = $1 AND path LIKE 'node_modules/%'`,
      [workspaceId],
    )
    expect(vendored).toHaveLength(0)

    // And the secret the corpus deliberately commits is still absent (AC5), at
    // benchmark scale rather than on a three-file fixture.
    const everything = JSON.stringify(
      await db.admin.query(`SELECT text FROM code_chunks WHERE workspace_id = $1 LIMIT 5000`, [
        workspaceId,
      ]),
    )
    expect(everything).not.toContain('hunter2')
  }, 900_000)

  it('BRAIN-2 AC6/AC2: re-indexing an unchanged corpus is a small fraction of the first pass', async () => {
    // The number that decides whether a repository stays current. A push
    // arrives every few minutes; if a re-index costs what a first index costs,
    // the index is permanently behind however fast the first one was.
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    const [repository] = await db.admin.query<{ id: string }>(
      `SELECT id FROM repositories WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    for (const table of ['route_map', 'code_chunks', 'code_symbols', 'code_imports', 'code_files']) {
      await db.admin.execute(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId])
    }

    const indexer = await createIndexer(db.config, {
      embed: async (texts) => texts.map(() => new Array<number>(1536).fill(0.01)),
      embeddingModel: 'benchmark-stub',
    })
    const workingCopy = join(corpusRoot, 'repo')

    const firstStarted = Date.now()
    await indexer.index({ workspaceId, repositoryId: repository!.id, workingCopy, commitSha: 'c1' })
    const firstMs = Date.now() - firstStarted

    const secondStarted = Date.now()
    const second = await indexer.index({
      workspaceId,
      repositoryId: repository!.id,
      workingCopy,
      commitSha: 'c2',
    })
    const secondMs = Date.now() - secondStarted

    console.warn(
      JSON.stringify({
        level: 'info',
        message: 'BRAIN-2 AC2 re-index benchmark',
        firstMs,
        secondMs,
        ratio: Number((secondMs / firstMs).toFixed(3)),
      }),
    )

    expect(second.stats.filesIndexed).toBe(0)
    // Generous, because the walk and the hashing still happen and that is the
    // floor. The assertion that matters is that no parsing, chunking or
    // embedding did.
    expect(secondMs).toBeLessThan(firstMs * 0.6)
  }, 900_000)
})
