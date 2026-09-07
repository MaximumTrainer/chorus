import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import {
  createRecordingMailer,
  createTestClient,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * WS-6 — the audit log, read.
 *
 * > audit rows are written from Phase 0 by the repository layer. This
 * > requirement is the *surface*: the log is worthless if it cannot be read.
 *
 * So nothing here is about whether rows are written — `mutate` has done that
 * since 0001 and NFR-5 asserts it. This is about the three things that make a
 * log usable when somebody is upset: finding the entry, trusting the page
 * boundaries, and getting the whole set out.
 */
describe('WS-6 audit log', () => {
  let db: IsolatedDatabase
  let client: TestClient

  interface World {
    ada: SignedInUser
    workspaceId: string
    teamId: string
  }

  async function world(): Promise<World> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Delivery')
    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    return { ada, workspaceId: workspace.id, teamId: teams[0]!.id }
  }

  interface Entry {
    id: string
    actorType: string
    actorId: string | null
    action: string
    targetType: string
    targetId: string | null
    at: string
  }

  const audit = async (
    w: World,
    query = '',
  ): Promise<{ entries: Entry[]; nextCursor: string | null }> =>
    (await (await w.ada.get(`/workspaces/${w.workspaceId}/audit${query}`)).json()) as {
      entries: Entry[]
      nextCursor: string | null
    }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    client = createTestClient(createApp({ dbConfig: db.config, mailer }), mailer)
  })

  it('WS-6 AC1: a mutation appears with its actor, action, target and time', async () => {
    // Given a workspace where somebody creates a task and edits a document
    const w = await world()
    const task = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, {
        title: 'Split the invoice parser',
      })
    ).json()) as { id: string }
    await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/documents`, {
      type: 'prd',
      title: 'Invoice splitting',
    })

    // When the audit log is queried
    const { entries } = await audit(w)

    // Then both appear, each attributable to the person who did it
    const created = entries.find(
      (entry) => entry.action === 'task.create' && entry.targetId === task.id,
    )
    expect(created, 'a created task must be findable in the log').toBeDefined()
    expect(created).toMatchObject({ actorType: 'user', actorId: w.ada.userId, targetType: 'task' })
    expect(Date.parse(created!.at)).toBeLessThanOrEqual(Date.now() + 1000)

    expect(entries.some((entry) => entry.action.startsWith('document.'))).toBe(true)
  })

  it('WS-6 AC3: filtering by action and actor returns exactly the matching entries', async () => {
    // Given a workspace with several kinds of change in it
    const w = await world()
    for (const title of ['One', 'Two', 'Three']) {
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, { title })
    }
    await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/documents`, {
      type: 'prd',
      title: 'Unrelated',
    })

    // When the log is filtered
    const { entries } = await audit(w, '?action=task.create')

    // Then it is exactly the matching set — not a superset the reader has to
    // filter again by eye, which is how somebody misses the entry they came for.
    expect(entries).toHaveLength(3)
    expect(entries.every((entry) => entry.action === 'task.create')).toBe(true)

    const byActor = await audit(w, `?actorId=${w.ada.userId}&action=task.create`)
    expect(byActor.entries).toHaveLength(3)

    const someoneElse = await audit(w, '?actorId=01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(someoneElse.entries).toEqual([])
  })

  it('WS-6 AC3: paging with a cursor is complete and non-overlapping', async () => {
    // Given more entries than fit on a page
    const w = await world()
    for (const title of ['A', 'B', 'C', 'D', 'E']) {
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, { title })
    }

    // When it is read a page at a time
    const first = await audit(w, '?action=task.create&limit=2')
    expect(first.entries).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()

    const second = await audit(w, `?action=task.create&limit=2&cursor=${first.nextCursor}`)
    const third = await audit(w, `?action=task.create&limit=2&cursor=${second.nextCursor}`)

    // Then every entry appears exactly once across the pages. Keyset paging
    // rather than an offset, because a log is written to while it is read: an
    // offset shifts under a concurrent write and silently skips a row, which
    // in an audit log is the one outcome nobody can accept.
    const seen = [...first.entries, ...second.entries, ...third.entries].map((entry) => entry.id)
    expect(new Set(seen).size).toBe(5)
    expect(third.nextCursor).toBeNull()
  })

  it('WS-6 AC3: a page boundary is stable when the log is written to underneath it', async () => {
    // Given a page already read
    const w = await world()
    for (const title of ['A', 'B', 'C']) {
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, { title })
    }
    const first = await audit(w, '?action=task.create&limit=2')

    // When more happens between the pages
    await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, { title: 'Later' })

    // Then the next page continues where the first stopped, and repeats nothing
    const second = await audit(w, `?action=task.create&limit=2&cursor=${first.nextCursor}`)
    const overlap = second.entries.filter((entry) =>
      first.entries.some((earlier) => earlier.id === entry.id),
    )
    expect(overlap, 'a cursor must not re-serve what the reader has seen').toEqual([])
  })

  it('WS-6 AC4: the export is exactly the filtered set, as JSON Lines and as CSV', async () => {
    // Given a filtered view
    const w = await world()
    for (const title of ['One', 'Two']) {
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, { title })
    }
    await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/documents`, {
      type: 'prd',
      title: 'Unrelated',
    })

    // When it is exported
    const jsonl = await w.ada.get(
      `/workspaces/${w.workspaceId}/audit/export?format=jsonl&action=task.create`,
    )
    expect(jsonl.status, await jsonl.clone().text()).toBe(200)
    expect(jsonl.headers.get('content-type')).toContain('application/x-ndjson')

    const lines = (await jsonl.text()).trim().split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      const entry = JSON.parse(line) as Entry
      expect(entry.action).toBe('task.create')
      // Every field, not the summary the list view happens to show: an export
      // that quietly drops `before`/`after` is the one somebody discovers the
      // day they need to prove what changed.
      expect(entry).toHaveProperty('targetId')
      expect(entry).toHaveProperty('at')
    }

    const csv = await w.ada.get(
      `/workspaces/${w.workspaceId}/audit/export?format=csv&action=task.create`,
    )
    expect(csv.headers.get('content-type')).toContain('text/csv')
    const rows = (await csv.text()).trim().split('\n')
    expect(rows[0]).toContain('action')
    expect(rows).toHaveLength(3)
  })

  it('WS-6 AC5: a member cannot read the audit log', async () => {
    // Given a member who is not an admin
    const w = await world()
    const bob = await client.signedInUser()
    await db.admin.execute(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, 'member')`,
      [`m${Date.now()}`, w.workspaceId, bob.userId],
    )

    // When they ask for it
    const refused = await bob.get(`/workspaces/${w.workspaceId}/audit`)

    // Then it is refused. The log names who did what, which is exactly the
    // information a colleague has no standing to browse.
    expect(refused.status).toBe(403)
    expect((await bob.get(`/workspaces/${w.workspaceId}/audit/export?format=csv`)).status).toBe(403)
  })
})
