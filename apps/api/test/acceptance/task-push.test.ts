import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ulid, type ExternalRef } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import type { TrackerSink } from '../../src/task-push.js'
import { createRecordingMailer, createTestClient, type TestClient } from '@chorus/testing'

/**
 * TASK-4 — pushing a task to a tracker creates the external issue and maps it.
 *
 * Chorus does not replace the tracker, so a pushed task is two objects kept in
 * step. These prove the first half: a push creates the issue and records the
 * mapping with its external id, key and url (AC1), and a repeated push updates
 * the one issue it already made rather than opening a second (AC4). The
 * external write is faked here — its real behaviour is the connector sink's,
 * proven in INT-4 — so what is under test is the push-and-map logic.
 */

/** A tracker sink that records its writes and dedupes a create by idempotency key. */
function fakeTrackerSink(): TrackerSink & {
  readonly created: Array<{ title: string; idempotencyKey: string }>
  readonly updated: Array<{ externalId: string }>
} {
  const created: Array<{ title: string; idempotencyKey: string }> = []
  const updated: Array<{ externalId: string }> = []
  const byKey = new Map<string, ExternalRef>()
  return {
    created,
    updated,
    async createIssue({ title, idempotencyKey }) {
      const existing = byKey.get(idempotencyKey)
      if (existing) return existing
      const n = created.length + 1
      const ref: ExternalRef = {
        externalId: `ext-${n}`,
        key: `ACME-${n}`,
        url: `https://linear.app/acme/ACME-${n}`,
      }
      created.push({ title, idempotencyKey })
      byKey.set(idempotencyKey, ref)
      return ref
    },
    async updateIssue({ externalId }) {
      updated.push({ externalId })
      const match = [...byKey.values()].find((ref) => ref.externalId === externalId)
      return match ?? { externalId }
    },
  }
}

describe('TASK-4 push a task to a tracker', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let sink: ReturnType<typeof fakeTrackerSink>

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    sink = fakeTrackerSink()
    client = createTestClient(createApp({ dbConfig: db.config, mailer, trackerSink: sink }), mailer)
  })

  async function world() {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Tracker push')
    const [team] = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{ id: string }>
    // A connected tracker for the workspace to push to.
    await db.admin.execute(`INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'linear')`, [
      ulid(),
      workspace.id,
    ])
    const task = (await (
      await ada.post(`/workspaces/${workspace.id}/teams/${team!.id}/tasks`, {
        title: 'Split the invoice parser',
      })
    ).json()) as { id: string; key: string }
    return { ada, workspaceId: workspace.id, teamId: team!.id, task }
  }

  it('TASK-4: pushing a task creates the external issue and stores the mapping', async () => {
    const w = await world()

    const response = await w.ada.post(`/workspaces/${w.workspaceId}/tasks/${w.task.id}/push`)
    expect(response.status, await response.clone().text()).toBe(200)
    const link = (await response.json()) as {
      externalId: string
      externalKey: string
      externalUrl: string
      syncState: string
    }

    // The mapping records the external identity (AC1).
    expect(link).toMatchObject({
      externalId: 'ext-1',
      externalKey: 'ACME-1',
      externalUrl: 'https://linear.app/acme/ACME-1',
      syncState: 'synced',
    })
    // The push sent the task's title, and created exactly one issue.
    expect(sink.created).toHaveLength(1)
    expect(sink.created[0]!.title).toBe('Split the invoice parser')

    // The row is stored with a content hash, so a later sync can detect drift.
    const [row] = await db.admin.query<{ external_id: string; last_synced_hash: string | null }>(
      `SELECT external_id, last_synced_hash FROM task_tracker_links WHERE task_id = $1`,
      [w.task.id],
    )
    expect(row?.external_id).toBe('ext-1')
    expect(row?.last_synced_hash, 'a synced link records the content hash').toBeTruthy()
  })

  it('TASK-4: a repeated push creates exactly one external issue (AC4)', async () => {
    const w = await world()

    const first = await w.ada.post(`/workspaces/${w.workspaceId}/tasks/${w.task.id}/push`)
    expect(first.status).toBe(200)
    const second = await w.ada.post(`/workspaces/${w.workspaceId}/tasks/${w.task.id}/push`)
    expect(second.status).toBe(200)

    // One issue created, the repeat updating the one it already made.
    expect(sink.created, 'a replayed push must not open a second issue').toHaveLength(1)
    expect(sink.updated).toHaveLength(1)

    // Still exactly one mapping row.
    const rows = await db.admin.query(`SELECT id FROM task_tracker_links WHERE task_id = $1`, [w.task.id])
    expect(rows).toHaveLength(1)
  })

  it('TASK-4: pushing with no connected tracker is refused', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('No tracker')
    const [team] = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{ id: string }>
    const task = (await (
      await ada.post(`/workspaces/${workspace.id}/teams/${team!.id}/tasks`, { title: 'Orphan' })
    ).json()) as { id: string }

    const response = await ada.post(`/workspaces/${workspace.id}/tasks/${task.id}/push`)
    expect(response.status).toBe(400)
    expect(await response.text()).toMatch(/no connected tracker/i)
  })
})
