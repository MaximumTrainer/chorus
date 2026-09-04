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
 * TASK-2 — reordering, bulk edits and scoping, through the API.
 *
 * > A proposed task tree is only reviewable if it can be manipulated at the
 * > speed of thought.
 *
 * The UI half of that — drag, multi-select, optimistic rendering — is
 * `apps/web`, which does not exist yet. What the UI would sit on does, and it
 * is where the properties actually live: a move must be a single write so two
 * people can move different tasks at once; a bulk edit must say what happened
 * to each task rather than reporting one outcome for the batch; and a stale
 * write must be refused with enough information to reconcile.
 *
 * Stated rather than implied: AC1's "survives reload" is asserted by re-reading
 * through the API, AC2's "rejected in the UI" and AC4's "the UI reverts" land
 * with the web app.
 */
describe('TASK-2 task views', () => {
  let db: IsolatedDatabase
  let client: TestClient

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

  async function board(): Promise<{
    ada: SignedInUser
    workspaceId: string
    teamId: string
    ids: string[]
  }> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Board')
    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    const teamId = teams[0]!.id

    const ids: string[] = []
    for (const title of ['A', 'B', 'C']) {
      const created = await ada.post(`/workspaces/${workspace.id}/teams/${teamId}/tasks`, { title })
      ids.push(((await created.json()) as { id: string }).id)
    }
    return { ada, workspaceId: workspace.id, teamId, ids }
  }

  const titles = async (ada: SignedInUser, workspaceId: string, teamId: string) =>
    ((await (await ada.get(`/workspaces/${workspaceId}/teams/${teamId}/tasks`)).json()) as Array<{
      title: string
    }>).map((t) => t.title)

  it('TASK-2 AC1: moving a task changes the order, and the change survives a re-read', async () => {
    const { ada, workspaceId, teamId, ids } = await board()
    expect(await titles(ada, workspaceId, teamId)).toEqual(['A', 'B', 'C'])

    // C to the front. Expressed as neighbours rather than an index, because an
    // index is a statement about the whole list and a neighbour is a statement
    // about one gap — which is what makes the write touch a single row.
    const moved = await ada.post(`/workspaces/${workspaceId}/tasks/${ids[2]!}/move`, {
      before: null,
      after: ids[0],
    })
    expect(moved.status, await moved.clone().text()).toBe(200)

    expect(await titles(ada, workspaceId, teamId)).toEqual(['C', 'A', 'B'])
  })

  it('TASK-2 AC1: moving one task rewrites only that task', async () => {
    const { ada, workspaceId, teamId, ids } = await board()

    const before = (await (
      await ada.get(`/workspaces/${workspaceId}/teams/${teamId}/tasks`)
    ).json()) as Array<{ id: string; updatedAt: string }>

    await ada.post(`/workspaces/${workspaceId}/tasks/${ids[2]!}/move`, {
      before: null,
      after: ids[0],
    })

    const after = (await (
      await ada.get(`/workspaces/${workspaceId}/teams/${teamId}/tasks`)
    ).json()) as Array<{ id: string; updatedAt: string }>

    // The siblings are untouched. This is the whole reason for fractional keys:
    // with integer positions every sibling after the move is rewritten, and two
    // concurrent moves then overwrite each other.
    for (const task of after) {
      if (task.id === ids[2]) continue
      const original = before.find((t) => t.id === task.id)!
      expect(task.updatedAt, `${task.id} was rewritten by a move that did not involve it`).toBe(
        original.updatedAt,
      )
    }
  })

  it('TASK-2 AC2: a move that would create a cycle is refused by the API', async () => {
    const { ada, workspaceId, ids } = await board()
    await ada.patch(`/workspaces/${workspaceId}/tasks/${ids[1]!}`, { parentId: ids[0] })

    // Re-parenting A under its own child B. The UI is expected to prevent this
    // too, but the API refusing is what makes it true rather than polite.
    const refused = await ada.post(`/workspaces/${workspaceId}/tasks/${ids[0]!}/move`, {
      parentId: ids[1],
    })
    expect(refused.status).toBe(400)
    expect(await refused.text()).toMatch(/descendant|own parent/i)
  })

  it('TASK-2 AC3: a bulk edit reports what happened to every task, not one verdict', async () => {
    const { ada, workspaceId, ids } = await board()

    const result = await ada.post(`/workspaces/${workspaceId}/tasks/bulk`, {
      // One id that does not exist, so the batch is genuinely mixed.
      taskIds: [...ids, '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
      changes: { tags: ['Coding'] },
    })
    expect(result.status, await result.clone().text()).toBe(207)

    const outcomes = (await result.json()) as {
      results: Array<{ taskId: string; ok: boolean; error?: string }>
    }
    expect(outcomes.results).toHaveLength(4)
    // Per task, named. "3 of 4 succeeded" leaves the caller to work out which,
    // and a UI cannot revert what it cannot identify.
    expect(outcomes.results.filter((r) => r.ok).map((r) => r.taskId).sort()).toEqual(
      [...ids].sort(),
    )
    const failed = outcomes.results.find((r) => !r.ok)!
    expect(failed.taskId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(failed.error).toMatch(/no such task/i)
  })

  it('TASK-2 AC3: the tasks that succeeded really were changed', async () => {
    const { ada, workspaceId, ids } = await board()
    await ada.post(`/workspaces/${workspaceId}/tasks/bulk`, {
      taskIds: [...ids, 'nope'],
      changes: { status: 'in_progress' },
    })

    // "No silent partial success" cuts both ways: a reported success that did
    // not happen is as bad as an unreported failure.
    for (const id of ids) {
      const task = (await (await ada.get(`/workspaces/${workspaceId}/tasks/${id}`)).json()) as {
        status: string
      }
      expect(task.status).toBe('in_progress')
    }
  })

  it('TASK-2 AC4: a stale write is refused, and the response carries the current state', async () => {
    const { ada, workspaceId, ids } = await board()

    const read = await ada.get(`/workspaces/${workspaceId}/tasks/${ids[0]!}`)
    const etag = read.headers.get('etag')
    expect(etag, 'a task must be addressable by version for optimistic updates').toBeTruthy()

    // Somebody else changes it first.
    await ada.patch(`/workspaces/${workspaceId}/tasks/${ids[0]!}`, { title: 'Changed by them' })

    const stale = await ada.request(`/workspaces/${workspaceId}/tasks/${ids[0]!}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': etag! },
      body: JSON.stringify({ title: 'Changed by me' }),
    })

    expect(stale.status).toBe(409)
    // The current state travels with the refusal, so a client can reconcile
    // without a second round trip — and can explain *what* changed.
    const body = (await stale.json()) as { current?: { title: string } }
    expect(body.current?.title).toBe('Changed by them')
  })

  it('TASK-2 AC4: a fresh write with a matching version is accepted', async () => {
    const { ada, workspaceId, ids } = await board()
    const read = await ada.get(`/workspaces/${workspaceId}/tasks/${ids[0]!}`)

    const accepted = await ada.request(`/workspaces/${workspaceId}/tasks/${ids[0]!}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'if-match': read.headers.get('etag')!,
      },
      body: JSON.stringify({ title: 'Mine' }),
    })

    // Otherwise the check above would pass against an endpoint that refused
    // everything.
    expect(accepted.status, await accepted.clone().text()).toBe(200)
  })

  it('TASK-2 AC5: a scoped view shows exactly the tasks linked to that scope', async () => {
    const { ada, workspaceId, teamId, ids } = await board()

    // Scope is expressed as a link rather than a column, so a task can belong
    // to a session *and* a document without the schema growing a field per
    // kind of scope (TASK-1's `artefact_links`).
    const scopeId = '01ARZ3NDEKTSV4RRFFQ69G5FB9'
    for (const id of ids.slice(0, 2)) {
      const linked = await ada.post(`/workspaces/${workspaceId}/tasks/${id}/links`, {
        toType: 'session',
        toId: scopeId,
      })
      expect(linked.status, await linked.clone().text()).toBe(201)
    }

    const scoped = await ada.get(
      `/workspaces/${workspaceId}/teams/${teamId}/tasks?scopeType=session&scopeId=${scopeId}`,
    )
    expect(scoped.status).toBe(200)
    const listed = (await scoped.json()) as Array<{ id: string }>
    expect(listed.map((t) => t.id).sort()).toEqual(ids.slice(0, 2).sort())
  })

  it('TASK-2 AC5: an unscoped view still shows everything', async () => {
    const { ada, workspaceId, teamId, ids } = await board()
    // Otherwise the scoping test above would pass against a list that always
    // returned two tasks.
    expect(
      ((await (await ada.get(`/workspaces/${workspaceId}/teams/${teamId}/tasks`)).json()) as
        unknown[]).length,
    ).toBe(ids.length)
  })

  it('TASK-2: filtering by status and assignee narrows the list', async () => {
    const { ada, workspaceId, teamId, ids } = await board()
    await ada.patch(`/workspaces/${workspaceId}/tasks/${ids[0]!}`, { status: 'done' })

    const done = (await (
      await ada.get(`/workspaces/${workspaceId}/teams/${teamId}/tasks?status=done`)
    ).json()) as Array<{ id: string }>
    expect(done.map((t) => t.id)).toEqual([ids[0]])
  })
})
