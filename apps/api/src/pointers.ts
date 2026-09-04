import {
  MIN_POINTER_CONFIDENCE,
  NotFoundError,
  deepLink,
  ulid,
  type CodePointer,
  type PointerSource,
  type Retriever,
} from '@chorus/core'
import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Code pointers (TASK-3).
 *
 * > A pointer that does not resolve is worse than none: it teaches everyone,
 * > human and machine, to distrust all of them.
 *
 * Three rules follow, and each is a place where the easy implementation is the
 * wrong one.
 *
 * **Validate before persisting.** The implementation note calls this "the
 * single most effective anti-hallucination measure in the product", and it is
 * the emit-step guarantee of §11.7 applied here: a pointer is written only
 * after the file and line range have been checked against the index. Writing
 * first and validating on read would put unresolvable pointers in front of
 * people, which is the failure the requirement is named for.
 *
 * **Nothing beats a guess.** Below the confidence floor no pointer is created.
 * A missing pointer costs a reader one search; a wrong one costs the
 * credibility of every other pointer.
 *
 * **Stale is marked, not deleted.** A file that moved leaves a pointer whose
 * last known good commit still links — which tells a reader what it used to
 * point at, where an absence tells them nothing.
 */

export interface PointerView extends CodePointer {
  /** Built here so every consumer — UI, brief, MCP — links identically. */
  readonly url: string
}

export interface PointerService {
  /** Replaces `generated` pointers for a task; leaves manual ones alone. */
  generate(input: {
    workspaceId: string
    taskId: string
    teamId: string
    userId: string
    query: string
  }): Promise<PointerView[]>
  list(workspaceId: string, taskId: string): Promise<PointerView[]>
  addManual(input: {
    workspaceId: string
    taskId: string
    userId: string
    repositoryId: string
    path: string
    lineStart: number
    lineEnd: number
    symbolName?: string
  }): Promise<PointerView>
  remove(workspaceId: string, pointerId: string): Promise<void>
  /** Re-checks every pointer against the index, marking those that no longer resolve. */
  revalidate(workspaceId: string, taskId: string): Promise<PointerView[]>
}

interface PointerRow {
  id: string
  task_id: string
  repository_id: string
  path: string
  symbol_name: string | null
  line_start: number
  line_end: number
  commit_sha: string | null
  source: PointerSource
  confidence: number
  stale_at: Date | null
  provider: string
  full_name: string
  default_branch: string
}

const SELECT = `
  SELECT p.id, p.task_id, p.repository_id, p.path, p.symbol_name, p.line_start, p.line_end,
         p.commit_sha, p.source, p.confidence, p.stale_at,
         r.provider, r.full_name, r.default_branch
    FROM code_pointers p
    JOIN repositories r ON r.id = p.repository_id`

function toView(row: PointerRow): PointerView {
  return {
    id: row.id,
    taskId: row.task_id,
    repositoryId: row.repository_id,
    path: row.path,
    symbolName: row.symbol_name,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    commitSha: row.commit_sha,
    source: row.source,
    confidence: row.confidence,
    staleAt: row.stale_at ? row.stale_at.toISOString() : null,
    url: deepLink({
      provider: row.provider,
      fullName: row.full_name,
      path: row.path,
      commitSha: row.commit_sha,
      defaultBranch: row.default_branch,
      lineStart: row.line_start,
      lineEnd: row.line_end,
    }),
  }
}

export function createPointerService(config: DbConfig, retriever: Retriever): PointerService {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>) =>
    withTenant(workspaceId, fn, { config })

  /**
   * Whether a pointer still names something real.
   *
   * Checks the file exists *and* that the line range is inside it. A range past
   * the end of a file is the specific way a generated pointer goes wrong when
   * the file shrank, and it opens to a blank screen rather than an error.
   */
  const resolves = async (
    t: TenantTx,
    input: { repositoryId: string; path: string; lineEnd: number },
  ): Promise<{ commitSha: string | null } | undefined> => {
    const [file] = await t.query<{ commit_sha: string | null; last_line: number | null }>(
      `SELECT f.commit_sha,
              (SELECT max(c.line_end) FROM code_chunks c WHERE c.file_id = f.id) AS last_line
         FROM code_files f
        WHERE f.repository_id = $1 AND f.path = $2`,
      [input.repositoryId, input.path],
    )
    if (!file) return undefined
    if (file.last_line !== null && input.lineEnd > file.last_line) return undefined
    return { commitSha: file.commit_sha }
  }

  const readAll = async (t: TenantTx, taskId: string): Promise<PointerView[]> => {
    const rows = await t.query<PointerRow>(
      `${SELECT} WHERE p.task_id = $1 ORDER BY p.confidence DESC, p.path`,
      [taskId],
    )
    return rows.map(toView)
  }

  return {
    async generate({ workspaceId, taskId, teamId, userId, query }) {
      // Retrieval is permission-filtered against the person the task is being
      // shaped for, so a pointer can never surface code they could not open
      // (BRAIN-4 AC2).
      const bundle = await retriever.retrieve({ workspaceId, teamId, userId, query, k: 5 })

      return tx(workspaceId, async (t) => {
        const [task] = await t.query<{ id: string }>(
          `SELECT id FROM tasks WHERE id = $1 AND deleted_at IS NULL`,
          [taskId],
        )
        if (!task) throw new NotFoundError('No such task', { taskId })

        // Only the generated ones. A person who corrected a pointer has told
        // us something the index does not know, and regeneration must not
        // discard it (AC4).
        await t.execute(`DELETE FROM code_pointers WHERE task_id = $1 AND source = 'generated'`, [
          taskId,
        ])

        for (const fragment of bundle.fragments) {
          // Below the floor, nothing is written. "No pointer beats a wrong
          // pointer" is enforced here rather than left to the caller.
          if (fragment.confidence < MIN_POINTER_CONFIDENCE) continue

          // Validated *before* persisting — the emit-step guarantee. A
          // fragment came from the index, so this is mostly a check that the
          // index has not moved on since the search; it is cheap and it is the
          // difference between a pointer and a hallucination.
          const found = await resolves(t, {
            repositoryId: fragment.repositoryId,
            path: fragment.path,
            lineEnd: fragment.lineEnd,
          })
          if (!found) continue

          await t.execute(
            `INSERT INTO code_pointers
               (id, workspace_id, task_id, repository_id, path, symbol_name, line_start,
                line_end, commit_sha, source, confidence, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'generated', $10, $11)
             ON CONFLICT (task_id, repository_id, path, line_start, line_end) DO NOTHING`,
            [
              ulid(),
              workspaceId,
              taskId,
              fragment.repositoryId,
              fragment.path,
              fragment.symbolName,
              fragment.lineStart,
              fragment.lineEnd,
              found.commitSha,
              fragment.confidence,
              userId,
            ],
          )
        }

        return readAll(t, taskId)
      })
    },

    async list(workspaceId, taskId) {
      return tx(workspaceId, (t) => readAll(t, taskId))
    },

    async addManual(input) {
      return tx(input.workspaceId, async (t) => {
        const id = ulid()
        await t.execute(
          `INSERT INTO code_pointers
             (id, workspace_id, task_id, repository_id, path, symbol_name, line_start,
              line_end, commit_sha, source, confidence, created_by)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, f.commit_sha, 'manual', 1, $9
             FROM code_files f
            WHERE f.repository_id = $4 AND f.path = $5`,
          [
            id,
            input.workspaceId,
            input.taskId,
            input.repositoryId,
            input.path,
            input.symbolName ?? null,
            input.lineStart,
            input.lineEnd,
            input.userId,
          ],
        )

        const [row] = await t.query<PointerRow>(`${SELECT} WHERE p.id = $1`, [id])
        // A manual pointer to a file the index has never seen is refused, not
        // stored: the whole requirement is that a pointer resolves, and a
        // person typing a path is at least as able to mistype one as a model.
        if (!row) {
          throw new NotFoundError(
            'That file is not in the index for this repository, so a pointer to it would not resolve',
            { path: input.path },
          )
        }
        return toView(row)
      })
    },

    async remove(workspaceId, pointerId) {
      await tx(workspaceId, (t) =>
        t.execute(`DELETE FROM code_pointers WHERE id = $1`, [pointerId]),
      )
    },

    async revalidate(workspaceId, taskId) {
      return tx(workspaceId, async (t) => {
        const rows = await t.query<PointerRow>(`${SELECT} WHERE p.task_id = $1`, [taskId])

        for (const row of rows) {
          const found = await resolves(t, {
            repositoryId: row.repository_id,
            path: row.path,
            lineEnd: row.line_end,
          })

          // Marked, not deleted, and the recorded commit is left alone so the
          // link still opens what it used to point at (AC5).
          await t.execute(`UPDATE code_pointers SET stale_at = $2 WHERE id = $1`, [
            row.id,
            found ? null : new Date().toISOString(),
          ])
        }

        return readAll(t, taskId)
      })
    },
  }
}
