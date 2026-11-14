import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type SignedInUser, type TestClient } from '@chorus/testing'

/**
 * NFR-4 AC4 / AC6 — exporting a workspace, over the API.
 *
 * An export is everything the workspace owns, so it is gated like erasure:
 * owner only, session only, and confirmed by typing the slug back. It is
 * audited before the first byte leaves. The body streams as
 * `chorus-export/v1` newline-delimited JSON, offered as a download.
 */
describe('NFR-4 workspace export route', () => {
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

  const exportOf = (user: SignedInUser, workspaceId: string, body: unknown) =>
    user.request(`/workspaces/${workspaceId}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  async function slugOf(user: SignedInUser, workspaceId: string): Promise<string> {
    return ((await (await user.get(`/workspaces/${workspaceId}`)).json()) as { slug: string }).slug
  }

  it('NFR-4 AC6: only an owner may export, and only by confirming the slug', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Exported carefully')
    const slug = await slugOf(ada, workspace.id)
    const admin = await client.memberWithRole(ada, workspace.id, 'admin')

    expect((await exportOf(admin, workspace.id, { confirm: slug })).status).toBe(403)
    expect((await exportOf(ada, workspace.id, {})).status).toBe(400)
    expect((await exportOf(ada, workspace.id, { confirm: 'not-this-one' })).status).toBe(400)
  })

  it('NFR-4 AC4 / AC6: an owner who confirms gets the export as a download, and it is audited', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Take it with you')
    const slug = await slugOf(ada, workspace.id)

    const res = await exportOf(ada, workspace.id, { confirm: slug })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="chorus-export-.+\.ndjson"/)

    const lines = (await res.text())
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { type: string; format?: string; tables?: Record<string, { rows: number }> })
    expect(lines[0]).toMatchObject({ type: 'header', format: 'chorus-export/v1' })
    const manifest = lines[lines.length - 1]!
    expect(manifest.type).toBe('manifest')
    // The workspace's own team and membership are in it.
    expect(manifest.tables!.teams!.rows).toBeGreaterThan(0)
    expect(manifest.tables!.workspace_members!.rows).toBeGreaterThan(0)

    const audit = await db.admin.query<{ actor_id: string }>(
      `SELECT actor_id FROM audit_events WHERE workspace_id = $1 AND action = 'workspace.export'`,
      [workspace.id],
    )
    expect(audit).toEqual([{ actor_id: ada.userId }])
  })
})
