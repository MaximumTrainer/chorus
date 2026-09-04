import { ulid } from '@chorus/core'
import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'
import { chunkFile } from './chunk.js'
import { detectRepository, type DetectedRepository } from './detect.js'
import { createParser, languageFor, type SourceParser } from './parse.js'
import { walkRepository, type WalkedFile } from './walk.js'

/**
 * The index run (BRAIN-2 AC1, AC2, AC7).
 *
 * Walk a working copy, parse what has a grammar, chunk everything, embed the
 * chunks, and record what commit the result represents. Two properties carry
 * their weight:
 *
 *  - **The index reports its commit.** A citation drawn from an index nobody
 *    can date is one nobody can trust: there is no way to tell whether the line
 *    it names still says what it said.
 *  - **A re-index touches only what changed**, decided by content hash. Not an
 *    optimisation — a full re-embed on every push is the difference between an
 *    index that stays current and one that is always an hour behind and
 *    expensive.
 */

export interface IndexFailure {
  readonly path: string
  readonly reason: string
}

export interface IndexStats {
  readonly filesSeen: number
  /** Parsed, chunked and embedded on this run. */
  readonly filesIndexed: number
  /** Skipped because their content hash was unchanged. */
  readonly filesUnchanged: number
  /** Gone from the working copy, and removed from the index. */
  readonly filesRemoved: number
  readonly chunksWritten: number
  readonly symbolsWritten: number
  readonly routesMapped: number
}

export interface IndexRun {
  readonly id: string
  readonly status: 'succeeded' | 'failed'
  readonly commitSha: string
  readonly stats: IndexStats
  /** Files we are blind to, and why (AC7). A list, not a count. */
  readonly failures: readonly IndexFailure[]
  /** Framework, routes, conventions, design system, preview provider (AC3, AC4). */
  readonly detected: DetectedRepository
}

/** Produces one vector per text. Never a real model in a test (CLAUDE.md §4). */
export type Embedder = (texts: readonly string[]) => Promise<number[][]>

export interface IndexerDeps {
  readonly embed: Embedder
  /** Part of the cache key: embeddings are not portable between models. */
  readonly embeddingModel: string
  /** Texts per embedding call. Batching is most of the wall-clock win. */
  readonly batchSize?: number
}

export interface Indexer {
  index(input: {
    workspaceId: string
    repositoryId: string
    /** A checked-out working copy. Disposable; the indexer never writes to it. */
    workingCopy: string
    commitSha: string
  }): Promise<IndexRun>
}

const DEFAULT_BATCH = 64

/** pgvector's literal form. */
const toVector = (values: readonly number[]): string => `[${values.join(',')}]`

export async function createIndexer(config: DbConfig, deps: IndexerDeps): Promise<Indexer> {
  const parser: SourceParser = await createParser()
  const batchSize = deps.batchSize ?? DEFAULT_BATCH

  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>): Promise<T> =>
    withTenant(workspaceId, fn, { config })

  return {
    async index({ workspaceId, repositoryId, workingCopy, commitSha }) {
      const runId = ulid()
      await tx(workspaceId, (t) =>
        t.execute(
          `INSERT INTO repo_index_runs (id, workspace_id, repository_id, commit_sha)
           VALUES ($1, $2, $3, $4)`,
          [runId, workspaceId, repositoryId, commitSha],
        ),
      )

      try {
        const files = await walkRepository(workingCopy)

        // What the index currently holds, so an unchanged file can be
        // recognised without re-reading anything downstream of it.
        const existing = new Map(
          (
            await tx(workspaceId, (t) =>
              t.query<{ id: string; path: string; content_hash: string }>(
                `SELECT id, path, content_hash FROM code_files WHERE repository_id = $1`,
                [repositoryId],
              ),
            )
          ).map((row) => [row.path, row]),
        )

        const seen = new Set(files.map((file) => file.path))
        const failures: IndexFailure[] = []
        let filesIndexed = 0
        let filesUnchanged = 0
        let chunksWritten = 0
        let symbolsWritten = 0

        for (const file of files) {
          const previous = existing.get(file.path)
          if (previous && previous.content_hash === file.contentHash) {
            filesUnchanged += 1
            // The commit moves even when the content did not, so the row still
            // says which commit it was last confirmed at.
            await tx(workspaceId, (t) =>
              t.execute(
                `UPDATE code_files SET commit_sha = $1, updated_at = now() WHERE id = $2`,
                [commitSha, previous.id],
              ),
            )
            continue
          }

          const written = await indexOneFile({
            workspaceId,
            repositoryId,
            commitSha,
            file,
            existingId: previous?.id,
          })
          filesIndexed += 1
          chunksWritten += written.chunks
          symbolsWritten += written.symbols
          if (written.failure) failures.push({ path: file.path, reason: written.failure })
        }

        // Files gone from the working copy. Removed rather than left behind: a
        // chunk that survives its file is a citation pointing at code that no
        // longer exists.
        const removed = [...existing.values()].filter((row) => !seen.has(row.path))
        if (removed.length > 0) {
          await tx(workspaceId, (t) =>
            t.execute(`DELETE FROM code_files WHERE id = ANY($1)`, [removed.map((row) => row.id)]),
          )
        }

        // Detection runs over the whole walk, not only the changed files: a
        // route map derived from a diff would lose every route whose file did
        // not happen to change, which is nearly all of them.
        const detected = detectRepository(files)
        await persistDetection(workspaceId, repositoryId, detected)

        const stats: IndexStats = {
          filesSeen: files.length,
          filesIndexed,
          filesUnchanged,
          filesRemoved: removed.length,
          chunksWritten,
          symbolsWritten,
          routesMapped: detected.routes.length,
        }

        await tx(workspaceId, (t) =>
          t.execute(
            `UPDATE repo_index_runs
                SET status = 'succeeded', stats = $1, failures = $2, finished_at = now()
              WHERE id = $3`,
            [JSON.stringify(stats), JSON.stringify(failures), runId],
          ),
        )

        return { id: runId, status: 'succeeded', commitSha, stats, failures, detected }
      } catch (error) {
        // Recorded before rethrowing, so "why is this repository not indexed"
        // has an answer rather than an absence.
        await tx(workspaceId, (t) =>
          t.execute(
            `UPDATE repo_index_runs
                SET status = 'failed', finished_at = now(),
                    failures = $1
              WHERE id = $2`,
            [
              JSON.stringify([
                { path: '(run)', reason: error instanceof Error ? error.message : String(error) },
              ]),
              runId,
            ],
          ),
        )
        throw error
      }

      /**
       * Replaces the route map and records what the repository says about
       * itself.
       *
       * Replaced wholesale rather than merged: a route deleted from the
       * repository must disappear from the map, and a merge would leave it
       * pointing at a file that no longer renders it — which is worse than an
       * absent route, because it looks like an answer.
       */
      async function persistDetection(
        workspaceId: string,
        repositoryId: string,
        detected: DetectedRepository,
      ): Promise<void> {
        await tx(workspaceId, async (t) => {
          const paths = new Map(
            (
              await t.query<{ id: string; path: string }>(
                `SELECT id, path FROM code_files WHERE repository_id = $1`,
                [repositoryId],
              )
            ).map((row) => [row.path, row.id]),
          )

          await t.execute(`DELETE FROM route_map WHERE repository_id = $1`, [repositoryId])
          for (const route of detected.routes) {
            await t.execute(
              `INSERT INTO route_map
                 (id, workspace_id, repository_id, route_pattern, component_file_id,
                  component_path, framework)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                ulid(),
                workspaceId,
                repositoryId,
                route.pattern,
                paths.get(route.componentPath) ?? null,
                route.componentPath,
                detected.framework,
              ],
            )
          }

          // Conventions live on the repository rather than the run: they are a
          // property of the repository as it stands, and the brief builder asks
          // "what is true now", never "what was true at run 47".
          await t.execute(
            `UPDATE repositories
                SET settings = COALESCE(settings, '{}'::jsonb) || $1::jsonb, updated_at = now()
              WHERE id = $2`,
            [
              JSON.stringify({
                framework: detected.framework,
                conventions: detected.conventions,
                designSystem: detected.designSystem,
                previewProvider: detected.previewProvider,
              }),
              repositoryId,
            ],
          )
        })
      }

      /**
       * Parses, chunks, embeds and stores one file.
       *
       * The delete-then-insert of symbols, imports and chunks is what makes a
       * re-index *replace* rather than accumulate — appending would leave a
       * renamed function findable under both names forever.
       */
      async function indexOneFile(input: {
        workspaceId: string
        repositoryId: string
        commitSha: string
        file: WalkedFile
        existingId: string | undefined
      }): Promise<{ chunks: number; symbols: number; failure?: string }> {
        const parsed = await parser.parse(input.file.path, input.file.text)
        const chunks = chunkFile(input.file.text, parsed.symbols)

        // Batched: one call per chunk is most of the wall-clock cost of an
        // index on any repository large enough for it to matter.
        const vectors: number[][] = []
        for (let start = 0; start < chunks.length; start += batchSize) {
          vectors.push(...(await deps.embed(chunks.slice(start, start + batchSize).map((c) => c.text))))
        }

        const fileId = input.existingId ?? ulid()

        await tx(input.workspaceId, async (t) => {
          if (input.existingId) {
            // Cascades to symbols, imports and chunks, so a re-index cannot
            // leave a stale symbol behind.
            await t.execute(`DELETE FROM code_symbols WHERE file_id = $1`, [fileId])
            await t.execute(`DELETE FROM code_imports WHERE file_id = $1`, [fileId])
            await t.execute(`DELETE FROM code_chunks WHERE file_id = $1`, [fileId])
            await t.execute(
              `UPDATE code_files
                  SET lang = $1, size_bytes = $2, content_hash = $3, commit_sha = $4,
                      parse_error = $5, updated_at = now()
                WHERE id = $6`,
              [
                languageFor(input.file.path) ?? null,
                input.file.bytes,
                input.file.contentHash,
                input.commitSha,
                parsed.failure ?? null,
                fileId,
              ],
            )
          } else {
            await t.execute(
              `INSERT INTO code_files
                 (id, workspace_id, repository_id, path, lang, size_bytes, content_hash,
                  commit_sha, parse_error)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                fileId,
                input.workspaceId,
                input.repositoryId,
                input.file.path,
                languageFor(input.file.path) ?? null,
                input.file.bytes,
                input.file.contentHash,
                input.commitSha,
                parsed.failure ?? null,
              ],
            )
          }

          for (const symbol of parsed.symbols) {
            await t.execute(
              `INSERT INTO code_symbols
                 (id, workspace_id, file_id, kind, name, line_start, line_end, signature)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                ulid(),
                input.workspaceId,
                fileId,
                symbol.kind,
                symbol.name,
                symbol.lineStart,
                symbol.lineEnd,
                symbol.signature,
              ],
            )
          }

          for (const specifier of new Set(parsed.imports)) {
            await t.execute(
              `INSERT INTO code_imports (id, workspace_id, file_id, specifier) VALUES ($1, $2, $3, $4)`,
              [ulid(), input.workspaceId, fileId, specifier],
            )
          }

          for (const [index, chunk] of chunks.entries()) {
            await t.execute(
              // `repository_id` is denormalised onto the chunk: filtering
              // through a join to `code_files` puts the retrieval indexes out
              // of the planner's reach (BRAIN-4 AC5). Safe because re-indexing
              // replaces a chunk rather than updating it, so the two cannot
              // drift.
              `INSERT INTO code_chunks
                 (id, workspace_id, repository_id, file_id, text, line_start, line_end,
                  symbol_name, symbol_kind, embedding)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                ulid(),
                input.workspaceId,
                input.repositoryId,
                fileId,
                chunk.text,
                chunk.lineStart,
                chunk.lineEnd,
                chunk.symbolName,
                chunk.symbolKind,
                vectors[index] ? toVector(vectors[index]!) : null,
              ],
            )
          }
        })

        return {
          chunks: chunks.length,
          symbols: parsed.symbols.length,
          ...(parsed.failure ? { failure: parsed.failure } : {}),
        }
      }
    },
  }
}
