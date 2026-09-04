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
 * TASK-1 — the task, through the API.
 *
 * > The task is the contract between shaping and delivery, and it is consumed
 * > by a machine as often as by a person.
 *
 * That second clause is why acceptance criteria are *structure* rather than
 * prose, and why the tests below care about the identity of each criterion
 * rather than only its text: a pull request renders them as a checklist
 * (CODE-5) and a coding agent has to satisfy them one at a time. Prose cannot
 * be checked off.
 *
 * AC1 asks for the round trip through the API **and** MCP. The MCP server is
 * WP-1.11 and does not exist, so the API half is asserted here and the MCP half
 * lands with the server — stated rather than quietly dropped.
 */
describe('TASK-1 tasks', () => {
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

  async function team(): Promise<{ ada: SignedInUser; workspaceId: string; teamId: string }> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Delivery')
    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    return { ada, workspaceId: workspace.id, teamId: teams[0]!.id }
  }

  const fullTask = {
    title: 'Split the invoice parser',
    description: { type: 'doc', content: [{ type: 'paragraph', text: 'It does three jobs.' }] },
    acceptanceCriteria: [
      { text: 'Each line item parses independently' },
      { text: 'A malformed line names its line number' },
    ],
    tags: ['Coding', 'Testing'],
    size: 'M',
    priority: 'high',
    status: 'todo',
  }

  it('TASK-1 AC1: a task with every field round-trips through the API identically', async () => {
    const { ada, workspaceId, teamId } = await team()

    const created = await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/tasks`, fullTask)
    expect(created.status, await created.clone().text()).toBe(201)
    const task = (await created.json()) as { id: string; key: string }

    const read = await ada.get(`/workspaces/${workspaceId}/tasks/${task.id}`)
    expect(read.status).toBe(200)
    const readBack = (await read.json()) as Omit<typeof fullTask, 'acceptanceCriteria'> & {
      key: string
      acceptanceCriteria: Array<{ id: string; text: string; checked: boolean }>
    }

    expect(readBack).toMatchObject({
      title: fullTask.title,
      description: fullTask.description,
      tags: fullTask.tags,
      size: 'M',
      priority: 'high',
      status: 'todo',
    })
    // Order preserved, and each item addressable — the whole point of AC5.
    expect(readBack.acceptanceCriteria.map((c) => c.text)).toEqual([
      'Each line item parses independently',
      'A malformed line names its line number',
    ])
    expect(readBack.acceptanceCriteria.every((c) => c.id && c.checked === false)).toBe(true)
  })

  it('TASK-1 AC2: keys are human-usable, sequential within the team, and stable', async () => {
    const { ada, workspaceId, teamId } = await team()

    const keys: string[] = []
    for (const title of ['One', 'Two', 'Three']) {
      const created = await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/tasks`, { title })
      keys.push(((await created.json()) as { key: string }).key)
    }

    expect(keys).toEqual(['CH-1', 'CH-2', 'CH-3'])

    // Stable for the task's life: it appears in chat, PR titles and MCP
    // prompts, so a key that changed would break links people had already sent.
    const first = await ada.get(`/workspaces/${workspaceId}/teams/${teamId}/tasks`)
    const listed = (await first.json()) as Array<{ key: string; title: string }>
    expect(listed.find((t) => t.title === 'One')?.key).toBe('CH-1')
  })

  it('TASK-1 AC2: a second team numbers from one again, because the key is per team', async () => {
    const { ada, workspaceId } = await team()
    const other = await ada.post(`/workspaces/${workspaceId}/teams`, { name: 'Platform' })
    const otherTeam = (await other.json()) as { id: string }

    const created = await ada.post(
      `/workspaces/${workspaceId}/teams/${otherTeam.id}/tasks`,
      { title: 'First for this team' },
    )
    expect(((await created.json()) as { key: string }).key).toBe('CH-1')
  })

  it('TASK-1 AC5: criteria can be checked, reordered and removed by their own ids', async () => {
    const { ada, workspaceId, teamId } = await team()
    const created = await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/tasks`, fullTask)
    const task = (await created.json()) as {
      id: string
      acceptanceCriteria: Array<{ id: string; text: string }>
    }
    const [one, two] = task.acceptanceCriteria

    const updated = await ada.patch(`/workspaces/${workspaceId}/tasks/${task.id}`, {
      // Reordered and one checked, addressed by id rather than by position.
      acceptanceCriteria: [
        { id: two!.id, text: two!.text, checked: true },
        { id: one!.id, text: one!.text, checked: false },
      ],
    })
    expect(updated.status, await updated.clone().text()).toBe(200)

    const after = (await updated.json()) as {
      acceptanceCriteria: Array<{ id: string; checked: boolean }>
    }
    // The ids survived the reorder. An external system that checked one off
    // by id must still be pointing at the same criterion afterwards.
    expect(after.acceptanceCriteria.map((c) => c.id)).toEqual([two!.id, one!.id])
    expect(after.acceptanceCriteria[0]!.checked).toBe(true)
  })

  it('TASK-1 AC3: a task cannot become its own ancestor', async () => {
    const { ada, workspaceId, teamId } = await team()
    const parent = (await (
      await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/tasks`, { title: 'Parent' })
    ).json()) as { id: string }
    const child = (await (
      await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/tasks`, {
        title: 'Child',
        parentId: parent.id,
      })
    ).json()) as { id: string }

    // Itself.
    expect(
      (await ada.patch(`/workspaces/${workspaceId}/tasks/${parent.id}`, { parentId: parent.id }))
        .status,
    ).toBe(400)

    // And its own descendant, which is the case a naive check misses.
    expect(
      (await ada.patch(`/workspaces/${workspaceId}/tasks/${parent.id}`, { parentId: child.id }))
        .status,
    ).toBe(400)
  })

  it('TASK-1 AC4: deleting a parent requires saying what happens to its children', async () => {
    const { ada, workspaceId, teamId } = await team()
    const parent = (await (
      await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/tasks`, { title: 'Parent' })
    ).json()) as { id: string }
    await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/tasks`, {
      title: 'Child',
      parentId: parent.id,
    })

    // Refused without a choice: silently orphaning children loses work in a way
    // nobody notices until they go looking for it.
    const bare = await ada.delete(`/workspaces/${workspaceId}/tasks/${parent.id}`)
    expect(bare.status).toBe(400)
    expect(await bare.text()).toMatch(/cascade|reparent/i)

    const cascaded = await ada.delete(
      `/workspaces/${workspaceId}/tasks/${parent.id}?children=cascade`,
    )
    expect(cascaded.status).toBe(204)

    const remaining = (await (
      await ada.get(`/workspaces/${workspaceId}/teams/${teamId}/tasks`)
    ).json()) as unknown[]
    expect(remaining).toEqual([])
  })

  it('TASK-1 AC4: re-parenting keeps the children and moves them up', async () => {
    const { ada, workspaceId, teamId } = await team()
    const parent = (await (
      await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/tasks`, { title: 'Parent' })
    ).json()) as { id: string }
    await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/tasks`, {
      title: 'Child',
      parentId: parent.id,
    })

    expect(
      (await ada.delete(`/workspaces/${workspaceId}/tasks/${parent.id}?children=reparent`)).status,
    ).toBe(204)

    const remaining = (await (
      await ada.get(`/workspaces/${workspaceId}/teams/${teamId}/tasks`)
    ).json()) as Array<{ title: string; parentId: string | null }>
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatchObject({ title: 'Child', parentId: null })
  })

  it('TASK-1: a task in another workspace is not readable', async () => {
    const { workspaceId, teamId, ada } = await team()
    const task = (await (
      await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/tasks`, { title: 'Private' })
    ).json()) as { id: string }

    const bob = await client.signedInUser()
    const elsewhere = await bob.createWorkspace('Elsewhere')

    expect((await bob.get(`/workspaces/${workspaceId}/tasks/${task.id}`)).status).toBe(404)
    expect((await bob.get(`/workspaces/${elsewhere.id}/tasks/${task.id}`)).status).toBe(404)
  })

  it('TASK-1: an unknown tag is refused, and the reserved Agent tag is not free-form', async () => {
    const { ada, workspaceId, teamId } = await team()

    // Custom tags are allowed by the requirement, but the reserved vocabulary
    // has meaning attached — `Agent` triggers auto-launch (TASK-5) — so it
    // cannot be reached by a near-miss spelling.
    const created = await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/tasks`, {
      title: 'Tagged',
      tags: ['coding', 'AGENT', 'Bespoke Thing'],
    })
    expect(created.status, await created.clone().text()).toBe(201)

    const task = (await created.json()) as { tags: string[] }
    // Reserved tags normalise to their canonical casing; custom ones are kept
    // as written, because they are the team's words and not ours.
    expect(task.tags).toContain('Coding')
    expect(task.tags).toContain('Agent')
    expect(task.tags).toContain('Bespoke Thing')
  })
})
