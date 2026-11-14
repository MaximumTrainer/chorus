import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type SignedInUser, type TestClient } from '@chorus/testing'

/**
 * NFR-4 AC5 / AC6 — erasing a workspace, over the API.
 *
 * Only an owner may erase a workspace, only from a session (never a token),
 * and only by typing its slug back — the one action in the product that cannot
 * be undone asks for proof that the person meant this workspace. The erasure
 * is recorded outside the workspace, since its own audit trail goes with it.
 */
describe('NFR-4 workspace erasure route', () => {
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

  const erase = (user: SignedInUser, workspaceId: string, body: unknown) =>
    user.request(`/workspaces/${workspaceId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  async function slugOf(user: SignedInUser, workspaceId: string): Promise<string> {
    const res = await user.get(`/workspaces/${workspaceId}`)
    return ((await res.json()) as { slug: string }).slug
  }

  it('NFR-4 AC6: only an owner may erase a workspace', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Kept by its owner')
    const slug = await slugOf(ada, workspace.id)
    const admin = await client.memberWithRole(ada, workspace.id, 'admin')
    const member = await client.memberWithRole(ada, workspace.id, 'member')

    expect((await erase(admin, workspace.id, { confirm: slug })).status).toBe(403)
    expect((await erase(member, workspace.id, { confirm: slug })).status).toBe(403)
    expect((await ada.get(`/workspaces/${workspace.id}`)).status).toBe(200)
  })

  it('NFR-4 AC6: erasure requires typing the workspace slug back', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Not by accident')

    expect((await erase(ada, workspace.id, {})).status).toBe(400)
    expect((await erase(ada, workspace.id, { confirm: 'some-other-workspace' })).status).toBe(400)
    expect((await ada.get(`/workspaces/${workspace.id}`)).status).toBe(200)
  })

  it('NFR-4 AC5 / AC6: an owner who confirms erases the workspace, and the erasure is recorded', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Gone for good')
    const slug = await slugOf(ada, workspace.id)

    const res = await erase(ada, workspace.id, { confirm: slug })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toMatchObject({ erased: true, residue: [] })

    // It no longer exists for anyone, its owner included.
    expect((await ada.get(`/workspaces/${workspace.id}`)).status).not.toBe(200)
    const listed = (await (await ada.get('/workspaces')).json()) as Array<{ id: string }>
    expect(listed.map((w) => w.id)).not.toContain(workspace.id)
    expect(await db.admin.query(`SELECT id FROM workspace_members WHERE workspace_id = $1`, [workspace.id])).toEqual([])

    const [record] = await db.admin.query<{ erased_by: string; workspace_name: string }>(
      `SELECT erased_by, workspace_name FROM workspace_erasures WHERE erased_workspace_id = $1`,
      [workspace.id],
    )
    expect(record).toMatchObject({ erased_by: ada.userId, workspace_name: 'Gone for good' })
  })
})
