import {
  MAX_TASK_DEPTH,
  keyBetween,
  needsRebalance,
  rebalance,
  NotFoundError,
  ValidationError,
  normaliseTags,
  ulid,
  type ChildDisposition,
  type CreateTask,
  type StoredAcceptanceCriterion,
  type TaskRecord,
  type UpdateTask,
} from '@chorus/core'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Tasks (TASK-1).
 *
 * Two things here are more delicate than they look, and both are about not
 * losing something quietly.
 *
 * **Keys** come from a per-team counter row taken with `SELECT … FOR UPDATE`,
 * not a sequence. A sequence is global rather than per team, and it leaves gaps
 * when a transaction rolls back — a list that jumps from CH-7 to CH-9 sends
 * somebody looking for CH-8. The lock serialises creation within one team and
 * nowhere else, which is the smallest scope that makes the numbers contiguous.
 *
 * **The tree** refuses cycles by walking ancestors rather than by checking the
 * immediate parent. `A → B → C` and then setting A's parent to C is the case a
 * naive check misses, and the result is a subtree that vanishes from every view
 * that walks down from a root.
 */

export interface TaskService {
  create(input: {
    workspaceId: string
    teamId: string
    actorId: string
    task: CreateTask
  }): Promise<TaskRecord>
  get(workspaceId: string, taskId: string): Promise<TaskRecord>
  listForTeam(
    workspaceId: string,
    teamId: string,
    filters?: TaskFilters,
  ): Promise<TaskRecord[]>
  update(input: {
    workspaceId: string
    taskId: string
    actorId: string
    changes: UpdateTask
  }): Promise<TaskRecord>
  remove(input: {
    workspaceId: string
    taskId: string
    actorId: string
    children: ChildDisposition
  }): Promise<void>
  /**
   * How many children a task has.
   *
   * So the route can demand a disposition only when there is something to
   * lose: insisting on one for a leaf would be ceremony rather than a
   * safeguard, and ceremony is what teaches people to pass the flag blindly.
   */
  childCount(workspaceId: string, taskId: string): Promise<number>
  /**
   * Places a task between two siblings, optionally under a new parent.
   *
   * Expressed as neighbours rather than an index: an index is a statement
   * about the whole list, and acting on one means rewriting every sibling
   * after it. A neighbour is a statement about one gap, so the write touches
   * a single row — which is what lets two people reorder at once (AC1).
   */
  move(input: {
    workspaceId: string
    taskId: string
    actorId: string
    before?: string | null | undefined
    after?: string | null | undefined
    parentId?: string | null | undefined
  }): Promise<TaskRecord>
  /** Applies one change to many tasks, reporting each outcome separately. */
  bulkUpdate(input: {
    workspaceId: string
    taskIds: readonly string[]
    actorId: string
    changes: UpdateTask
  }): Promise<BulkOutcome[]>
  link(input: {
    workspaceId: string
    taskId: string
    actorId: string
    toType: string
    toId: string
    relation?: string
  }): Promise<void>
}

/**
 * What happened to one task in a bulk operation (AC3).
 *
 * Per task and named. "Three of four succeeded" leaves the caller to work out
 * which, and a client cannot revert what it cannot identify.
 */
/**
 * How a view narrows the list (AC5, and the filtering half of the scope).
 *
 * `scope` is a *link* rather than a column: a task can belong to a session and
 * a document at once, and a column per kind of scope is how a schema acquires
 * a dozen nullable foreign keys and no way to ask what something belongs to.
 */
export interface TaskFilters {
  readonly scope?: { readonly type: string; readonly id: string } | undefined
  readonly status?: string | undefined
  readonly assigneeId?: string | undefined
  readonly tag?: string | undefined
}

export interface BulkOutcome {
  readonly taskId: string
  readonly ok: boolean
  readonly error?: string
}

interface TaskRow {
  id: string
  key: string
  team_id: string
  parent_id: string | null
  title: string
  description: Record<string, unknown>
  acceptance_criteria: StoredAcceptanceCriterion[]
  tags: string[]
  status: TaskRecord['status']
  priority: TaskRecord['priority']
  size: TaskRecord['size']
  assignee_id: string | null
  position: number
  created_by: string
  created_at: Date
  updated_at: Date
}

const COLUMNS = `id, key, team_id, parent_id, title, description, acceptance_criteria, tags,
                 status, priority, size, assignee_id, position, created_by, created_at, updated_at`

function toRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    key: row.key,
    teamId: row.team_id,
    parentId: row.parent_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    tags: row.tags,
    status: row.status,
    priority: row.priority,
    size: row.size,
    assigneeId: row.assignee_id,
    position: row.position,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

/**
 * Gives every criterion an id, keeping the ones it already has.
 *
 * The keeping is the point (AC5). An external system that checked a criterion
 * off by id must still be addressing the same criterion after somebody
 * reorders the list, so ids survive a reorder and only a genuinely new item
 * gets a new one.
 */
function withIds(
  criteria: ReadonlyArray<{ id?: string | undefined; text: string; checked?: boolean | undefined }>,
): StoredAcceptanceCriterion[] {
  return criteria.map((criterion) => ({
    id: criterion.id ?? ulid(),
    text: criterion.text,
    checked: criterion.checked ?? false,
  }))
}

export function createTaskService(config: DbConfig): TaskService {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>, userId?: string) =>
    withTenant(workspaceId, fn, { config, ...(userId ? { userId } : {}) })

  /**
   * The gap a move should land in, as the keys either side of it.
   *
   * Resolved against the task's *actual adjacent* siblings rather than against
   * the two ids the caller named. Those are not the same thing: a caller says
   * "after A", and A may have twenty tasks after it — subdividing between the
   * two named ids then lands somewhere in the middle of them, and can hit an
   * existing key exactly. Between two genuinely adjacent siblings there is
   * nothing to hit.
   */
  const gapFor = async (
    t: TenantTx,
    input: {
      teamId: string
      parentId: string | null
      movingId: string
      before: string | null | undefined
      after: string | null | undefined
    },
  ): Promise<{ left?: number | undefined; right?: number | undefined } | undefined> => {
    if (input.before == null && input.after == null) return undefined

    const siblings = await t.query<{ id: string; position: number }>(
      `SELECT id, position FROM tasks
        WHERE team_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL
          AND id <> $3
        ORDER BY position, created_at`,
      [input.teamId, input.parentId, input.movingId],
    )

    // "Immediately after `before`" is the primary reading; `after` covers the
    // case of dropping at the very top, where there is no task above.
    if (input.before != null) {
      const index = siblings.findIndex((sibling) => sibling.id === input.before)
      if (index === -1) return undefined
      return {
        left: siblings[index]!.position,
        ...(siblings[index + 1] ? { right: siblings[index + 1]!.position } : {}),
      }
    }

    const index = siblings.findIndex((sibling) => sibling.id === input.after)
    if (index === -1) return undefined
    return {
      ...(siblings[index - 1] ? { left: siblings[index - 1]!.position } : {}),
      right: siblings[index]!.position,
    }
  }

  const load = async (t: TenantTx, taskId: string): Promise<TaskRow> => {
    const [row] = await t.query<TaskRow>(
      `SELECT ${COLUMNS} FROM tasks WHERE id = $1 AND deleted_at IS NULL`,
      [taskId],
    )
    // A task in another workspace and one that never existed are alike from
    // here: row-level security did not surface it, and saying which is which
    // would leak existence (WS-2 AC4).
    if (!row) throw new NotFoundError('No such task', { taskId })
    return row
  }

  /**
   * The next key for a team, and the lock that makes it contiguous.
   *
   * `INSERT … ON CONFLICT DO UPDATE` both creates the counter on first use and
   * takes the row lock, in one statement — a separate read-then-write would be
   * the very race this exists to prevent.
   */
  const nextKey = async (t: TenantTx, workspaceId: string, teamId: string): Promise<string> => {
    const [row] = await t.query<{ next_number: number }>(
      `INSERT INTO task_counters (workspace_id, team_id, next_number)
       VALUES ($1, $2, 2)
       ON CONFLICT (workspace_id, team_id) DO UPDATE
         SET next_number = task_counters.next_number + 1
       RETURNING task_counters.next_number - 1 AS next_number`,
      [workspaceId, teamId],
    )
    return `CH-${row!.next_number}`
  }

  /**
   * Refuses a parent that would create a cycle or exceed the depth limit.
   *
   * Walks the ancestry rather than checking the immediate parent: `A → B → C`
   * and then A's parent set to C is the case a naive check misses, and it
   * detaches the whole subtree from every view that walks down from a root.
   */
  const assertPlaceable = async (
    t: TenantTx,
    taskId: string,
    parentId: string,
  ): Promise<void> => {
    if (parentId === taskId) {
      throw new ValidationError('A task cannot be its own parent', { field: 'parentId' })
    }

    let cursor: string | null = parentId
    let depth = 1
    const seen = new Set<string>([taskId])

    while (cursor) {
      if (seen.has(cursor)) {
        throw new ValidationError(
          'That parent is one of this task’s own descendants, which would detach the subtree',
          { field: 'parentId' },
        )
      }
      seen.add(cursor)

      depth += 1
      if (depth > MAX_TASK_DEPTH) {
        throw new ValidationError(
          `A task may be nested at most ${MAX_TASK_DEPTH} deep; a deeper tree is one nobody reads`,
          { field: 'parentId', maxDepth: MAX_TASK_DEPTH },
        )
      }

      const rows: Array<{ parent_id: string | null }> = await t.query(
        `SELECT parent_id FROM tasks WHERE id = $1 AND deleted_at IS NULL`,
        [cursor],
      )
      const found = rows[0]
      if (!found) throw new NotFoundError('No such parent task', { parentId })
      cursor = found.parent_id
    }
  }

  return {
    async create({ workspaceId, teamId, actorId, task }) {
      return tx(
        workspaceId,
        async (t) => {
          const id = ulid()
          if (task.parentId) await assertPlaceable(t, id, task.parentId)

          const key = await nextKey(t, workspaceId, teamId)

          // A new task goes after its current siblings. Leaving every task at
          // the column default put them all at position 0, where the order
          // fell back to `created_at` and the first move produced a collision
          // — silently, because positions are not unique.
          const [furthest] = await t.query<{ position: number | null }>(
            `SELECT max(position) AS position FROM tasks
              WHERE team_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL`,
            [teamId, task.parentId ?? null],
          )
          const position = keyBetween(furthest?.position ?? undefined, undefined)
          const criteria = withIds(task.acceptanceCriteria)
          const tags = normaliseTags(task.tags)

          const created = await mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            action: 'task.create',
            targetType: 'task',
            targetId: id,
            after: { key, title: task.title },
            apply: async () => {
              const [row] = await t.query<TaskRow>(
                `INSERT INTO tasks
                   (id, workspace_id, team_id, key, parent_id, title, description,
                    acceptance_criteria, tags, status, priority, size, assignee_id, created_by,
                    position)
                 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13,
                         $14, $15)
                 RETURNING ${COLUMNS}`,
                [
                  id,
                  workspaceId,
                  teamId,
                  key,
                  task.parentId ?? null,
                  task.title,
                  JSON.stringify(task.description),
                  JSON.stringify(criteria),
                  tags,
                  task.status,
                  task.priority,
                  task.size ?? null,
                  task.assigneeId ?? null,
                  actorId,
                  position,
                ],
              )
              return row!
            },
          })

          return toRecord(created)
        },
        actorId,
      )
    },

    async get(workspaceId, taskId) {
      return tx(workspaceId, async (t) => toRecord(await load(t, taskId)))
    },

    async listForTeam(workspaceId, teamId, filters = {}) {
      return tx(workspaceId, async (t) => {
        const where: string[] = ['team_id = $1', 'deleted_at IS NULL']
        const params: unknown[] = [teamId]
        const add = (clause: (placeholder: string) => string, value: unknown): void => {
          params.push(value)
          where.push(clause(`$${params.length}`))
        }

        if (filters.status) add((p) => `status = ${p}`, filters.status)
        if (filters.assigneeId) add((p) => `assignee_id = ${p}`, filters.assigneeId)
        if (filters.tag) add((p) => `${p} = ANY(tags)`, filters.tag)
        if (filters.scope) {
          params.push(filters.scope.type, filters.scope.id)
          where.push(
            `EXISTS (SELECT 1 FROM artefact_links l
                      WHERE l.from_type = 'task' AND l.from_id = tasks.id
                        AND l.to_type = $${params.length - 1} AND l.to_id = $${params.length})`,
          )
        }

        const rows = await t.query<TaskRow>(
          `SELECT ${COLUMNS} FROM tasks
            WHERE ${where.join(' AND ')}
            ORDER BY position, created_at`,
          params,
        )
        return rows.map(toRecord)
      })
    },

    async update({ workspaceId, taskId, actorId, changes }) {
      return tx(
        workspaceId,
        async (t) => {
          const before = await load(t, taskId)
          if (changes.parentId) await assertPlaceable(t, taskId, changes.parentId)

          // Absent leaves a field alone; `null` clears it. Collapsing the two
          // would make it impossible to un-parent or un-assign anything.
          const set: string[] = []
          const params: unknown[] = [taskId]
          const assign = (column: string, value: unknown): void => {
            params.push(value)
            set.push(`${column} = $${params.length}`)
          }

          if (changes.title !== undefined) assign('title', changes.title)
          if (changes.description !== undefined) {
            params.push(JSON.stringify(changes.description))
            set.push(`description = $${params.length}::jsonb`)
          }
          if (changes.acceptanceCriteria !== undefined) {
            params.push(JSON.stringify(withIds(changes.acceptanceCriteria)))
            set.push(`acceptance_criteria = $${params.length}::jsonb`)
          }
          if (changes.tags !== undefined) assign('tags', normaliseTags(changes.tags))
          if (changes.status !== undefined) assign('status', changes.status)
          if (changes.priority !== undefined) assign('priority', changes.priority)
          if (changes.size !== undefined) assign('size', changes.size)
          if (changes.assigneeId !== undefined) assign('assignee_id', changes.assigneeId)
          if (changes.parentId !== undefined) assign('parent_id', changes.parentId)
          if (changes.position !== undefined) assign('position', changes.position)

          if (set.length === 0) return toRecord(before)

          const updated = await mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            action: 'task.update',
            targetType: 'task',
            targetId: taskId,
            before: { title: before.title, status: before.status, parentId: before.parent_id },
            after: { changed: Object.keys(changes) },
            apply: async () => {
              const [row] = await t.query<TaskRow>(
                `UPDATE tasks SET ${set.join(', ')}, updated_at = now()
                  WHERE id = $1 RETURNING ${COLUMNS}`,
                params,
              )
              return row!
            },
          })

          return toRecord(updated)
        },
        actorId,
      )
    },

    async move({ workspaceId, taskId, actorId, before, after, parentId }) {
      return tx(
        workspaceId,
        async (t) => {
          const current = await load(t, taskId)
          if (parentId) await assertPlaceable(t, taskId, parentId)

          const parentOf = parentId === undefined ? current.parent_id : parentId
          const locate = { teamId: current.team_id, parentId: parentOf, movingId: taskId, before, after }

          let gap = await gapFor(t, locate)
          let position = gap === undefined ? current.position : keyBetween(gap.left, gap.right)

          // Precision runs out. It happens rarely — gaps start 1024 apart — and
          // it must not happen silently: two tasks sharing a key order
          // arbitrarily, so a list that was stable yesterday quietly stops
          // being so. Spreading the siblings out again is the one operation
          // that rewrites them all, which is affordable because it is rare.
          if (gap?.left !== undefined && gap.right !== undefined && needsRebalance(gap.left, gap.right)) {
            const ordered = await t.query<{ id: string }>(
              `SELECT id FROM tasks
                WHERE team_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL
                ORDER BY position, created_at`,
              [current.team_id, parentOf],
            )
            const spread = rebalance(ordered.length)
            for (const [index, sibling] of ordered.entries()) {
              await t.execute(`UPDATE tasks SET position = $2 WHERE id = $1`, [
                sibling.id,
                spread[index],
              ])
            }

            // Recomputed against the neighbours' *new* keys: the old ones
            // describe an ordering that no longer exists.
            gap = await gapFor(t, locate)
            position = gap === undefined ? current.position : keyBetween(gap.left, gap.right)
          }

          const moved = await mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            action: 'task.move',
            targetType: 'task',
            targetId: taskId,
            before: { position: current.position, parentId: current.parent_id },
            after: { position, parentId: parentId ?? current.parent_id },
            apply: async () => {
              const [row] = await t.query<TaskRow>(
                `UPDATE tasks
                    SET position = $2,
                        parent_id = CASE WHEN $3::boolean THEN $4 ELSE parent_id END,
                        updated_at = now()
                  WHERE id = $1 RETURNING ${COLUMNS}`,
                [taskId, position, parentId !== undefined, parentId ?? null],
              )
              return row!
            },
          })

          return toRecord(moved)
        },
        actorId,
      )
    },

    async bulkUpdate({ workspaceId, taskIds, actorId, changes }) {
      const outcomes: BulkOutcome[] = []

      // One transaction per task, deliberately. A single transaction would make
      // the batch all-or-nothing, and AC3 asks for the opposite: precisely which
      // succeeded and which failed. A caller that wanted atomicity would be
      // asking a different question.
      for (const taskId of taskIds) {
        try {
          await this.update({ workspaceId, taskId, actorId, changes })
          outcomes.push({ taskId, ok: true })
        } catch (error) {
          outcomes.push({
            taskId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      return outcomes
    },

    async link({ workspaceId, taskId, actorId, toType, toId, relation }) {
      await tx(
        workspaceId,
        async (t) => {
          await load(t, taskId)
          await t.execute(
            `INSERT INTO artefact_links
               (id, workspace_id, from_type, from_id, to_type, to_id, relation, created_by)
             VALUES ($1, $2, 'task', $3, $4, $5, $6, $7)
             ON CONFLICT DO NOTHING`,
            [ulid(), workspaceId, taskId, toType, toId, relation ?? 'relates_to', actorId],
          )
        },
        actorId,
      )
    },

    async childCount(workspaceId, taskId) {
      const [row] = await tx(workspaceId, (t) =>
        t.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM tasks
            WHERE parent_id = $1 AND deleted_at IS NULL`,
          [taskId],
        ),
      )
      return Number(row?.n ?? 0)
    },

    async remove({ workspaceId, taskId, actorId, children }) {
      await tx(
        workspaceId,
        async (t) => {
          const task = await load(t, taskId)

          await mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            action: `task.delete.${children}`,
            targetType: 'task',
            targetId: taskId,
            before: { key: task.key, title: task.title },
            apply: async () => {
              if (children === 'reparent') {
                // Up one level, to this task's own parent — which is `null` for
                // a root, so they become roots. Deleting a parent should not
                // decide where its children belong beyond keeping them.
                await t.execute(
                  `UPDATE tasks SET parent_id = $2, updated_at = now()
                    WHERE parent_id = $1 AND deleted_at IS NULL`,
                  [taskId, task.parent_id],
                )
              } else {
                // Cascade, depth-first through the subtree. Recursive rather
                // than one level, because a grandchild left behind is exactly
                // the orphan AC4 forbids.
                await t.execute(
                  `WITH RECURSIVE subtree AS (
                     SELECT id FROM tasks WHERE id = $1
                     UNION ALL
                     SELECT child.id FROM tasks child
                       JOIN subtree ON child.parent_id = subtree.id
                   )
                   UPDATE tasks SET deleted_at = now()
                    WHERE id IN (SELECT id FROM subtree) AND id <> $1`,
                  [taskId],
                )
              }

              await t.execute(`UPDATE tasks SET deleted_at = now() WHERE id = $1`, [taskId])
            },
          })
        },
        actorId,
      )
    },
  }
}

/**
 * The caller's choice about a parent's children (AC4).
 *
 * A missing choice is refused rather than defaulted, and neither default would
 * do: cascading loses work nobody agreed to lose, and re-parenting silently
 * changes a tree somebody arranged. Children are never orphaned because there
 * is no path here that leaves them without a decision.
 */
export function requireChildDisposition(value: unknown): ChildDisposition {
  if (value === 'cascade' || value === 'reparent') return value
  throw new ValidationError(
    'This task has children. Choose `?children=cascade` to delete them too, or ' +
      '`?children=reparent` to keep them and move them up one level.',
    { field: 'children' },
  )
}
