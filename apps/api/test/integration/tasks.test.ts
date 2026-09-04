import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid, CreateTaskSchema } from '@chorus/core'
import { createTaskService, type TaskService } from '../../src/tasks.js'

/**
 * TASK-1 — the properties only a real database shows.
 *
 * Key allocation and cycle prevention are both about concurrency and recursion,
 * and neither can be demonstrated against a mock: the first needs two
 * transactions racing for the same row, and the second needs a tree the
 * database actually holds.
 */
describe('TASK-1 task service', () => {
  let db: IsolatedDatabase
  let tasks: TaskService

  async function world(): Promise<{ workspaceId: string; teamId: string; userId: string }> {
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
    // The seed plants one of everything so the tenancy suite has rows to work
    // with, this table included. Left in place it would start the key counter
    // at two and make every assertion here off by one.
    await db.admin.execute(`DELETE FROM artefact_links WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM tasks WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM task_counters WHERE workspace_id = $1`, [workspaceId])
    return { workspaceId, teamId: team!.id, userId: member!.user_id }
  }

  const task = (title: string, extra: Record<string, unknown> = {}) =>
    CreateTaskSchema.parse({ title, ...extra })

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    tasks = createTaskService(db.config)
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('TASK-1 AC2: concurrent creation yields unique sequential keys with no gaps or reuse', async () => {
    const { workspaceId, teamId, userId } = await world()

    // Twenty at once, which is what a structure proposal being confirmed looks
    // like (CHAT-5) — the case a read-then-write allocator gets wrong.
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        tasks.create({ workspaceId, teamId, actorId: userId, task: task(`Task ${i}`) }),
      ),
    )

    const numbers = created.map((t) => Number(t.key.replace('CH-', ''))).sort((a, b) => a - b)
    expect(new Set(numbers).size, 'two tasks were given the same key').toBe(20)
    // Contiguous, not merely unique. A sequence would satisfy uniqueness and
    // still leave holes, and a list that jumps from CH-7 to CH-9 sends somebody
    // looking for CH-8.
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
  })

  it('TASK-1 AC2: a deleted task does not release its key', async () => {
    const { workspaceId, teamId, userId } = await world()
    const first = await tasks.create({ workspaceId, teamId, actorId: userId, task: task('One') })
    await tasks.remove({ workspaceId, taskId: first.id, actorId: userId, children: 'cascade' })

    const second = await tasks.create({ workspaceId, teamId, actorId: userId, task: task('Two') })
    // Reuse would point every old link, PR title and chat message at the wrong
    // task — silently, and long after anybody could connect the two.
    expect(second.key).toBe('CH-2')
  })

  it('TASK-1 AC3: a parent that is a descendant is refused, however deep', async () => {
    const { workspaceId, teamId, userId } = await world()
    const a = await tasks.create({ workspaceId, teamId, actorId: userId, task: task('A') })
    const b = await tasks.create({
      workspaceId,
      teamId,
      actorId: userId,
      task: task('B', { parentId: a.id }),
    })
    const c = await tasks.create({
      workspaceId,
      teamId,
      actorId: userId,
      task: task('C', { parentId: b.id }),
    })

    // Two levels down, which is the case an immediate-parent check misses —
    // and the result would be a subtree detached from every view that walks
    // down from a root.
    await expect(
      tasks.update({ workspaceId, taskId: a.id, actorId: userId, changes: { parentId: c.id } }),
    ).rejects.toThrow(/descendant/i)
  })

  it('TASK-1 AC3: nesting beyond the limit is refused', async () => {
    const { workspaceId, teamId, userId } = await world()

    let parentId: string | undefined
    const created: string[] = []
    for (let depth = 0; depth < 5; depth += 1) {
      const made = await tasks.create({
        workspaceId,
        teamId,
        actorId: userId,
        task: task(`Level ${depth}`, parentId ? { parentId } : {}),
      })
      created.push(made.id)
      parentId = made.id
    }

    await expect(
      tasks.create({
        workspaceId,
        teamId,
        actorId: userId,
        task: task('Too deep', { parentId }),
      }),
    ).rejects.toThrow(/nested at most/i)
  })

  it('TASK-1 AC4: cascading reaches grandchildren, not only children', async () => {
    const { workspaceId, teamId, userId } = await world()
    const a = await tasks.create({ workspaceId, teamId, actorId: userId, task: task('A') })
    const b = await tasks.create({
      workspaceId,
      teamId,
      actorId: userId,
      task: task('B', { parentId: a.id }),
    })
    await tasks.create({
      workspaceId,
      teamId,
      actorId: userId,
      task: task('C', { parentId: b.id }),
    })

    await tasks.remove({ workspaceId, taskId: a.id, actorId: userId, children: 'cascade' })

    // A grandchild left behind is exactly the orphan AC4 forbids — and it
    // would be invisible, because nothing walks down to it any more.
    expect(await tasks.listForTeam(workspaceId, teamId)).toEqual([])
  })

  it('TASK-1 AC6: every mutation writes an audit event in the same transaction', async () => {
    const { workspaceId, teamId, userId } = await world()

    const created = await tasks.create({
      workspaceId,
      teamId,
      actorId: userId,
      task: task('Audited'),
    })
    await tasks.update({
      workspaceId,
      taskId: created.id,
      actorId: userId,
      changes: { status: 'in_progress' },
    })
    await tasks.remove({
      workspaceId,
      taskId: created.id,
      actorId: userId,
      children: 'cascade',
    })

    const events = await db.admin.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_events
        WHERE workspace_id = $1 AND target_type = 'task' AND target_id = $2
        ORDER BY at`,
      [workspaceId, created.id],
    )

    expect(events.map((e) => e.action)).toEqual([
      'task.create',
      'task.update',
      'task.delete.cascade',
    ])
    expect(events.every((e) => e.actor_id === userId)).toBe(true)
  })

  it('TASK-1 AC6: a refused change writes no audit event', async () => {
    const { workspaceId, teamId, userId } = await world()
    const a = await tasks.create({ workspaceId, teamId, actorId: userId, task: task('A') })

    await expect(
      tasks.update({ workspaceId, taskId: a.id, actorId: userId, changes: { parentId: a.id } }),
    ).rejects.toThrow()

    // An audit trail that records attempts as though they happened is worse
    // than one that records nothing: it makes every entry require checking.
    const events = await db.admin.query<{ action: string }>(
      `SELECT action FROM audit_events
        WHERE workspace_id = $1 AND target_id = $2 AND action = 'task.update'`,
      [workspaceId, a.id],
    )
    expect(events).toEqual([])
  })

  it('TASK-1: reading a task from another workspace finds nothing', async () => {
    const one = await world()
    const other = await world()
    const created = await tasks.create({
      workspaceId: one.workspaceId,
      teamId: one.teamId,
      actorId: one.userId,
      task: task('Private'),
    })

    await expect(tasks.get(other.workspaceId, created.id)).rejects.toThrow(/no such task/i)
  })
})
