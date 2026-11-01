import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ulid, type ExternalRef } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createTaskSyncService } from '../../src/task-sync.js'
import { createTaskService } from '../../src/tasks.js'
import type { TrackerSink } from '../../src/task-push.js'
import { createRecordingMailer, createTestClient, type TestClient } from '@chorus/testing'

/**
 * TASK-4 — inbound status mirror and the conflict state.
 *
 * The conflict state is the requirement that distinguishes an honest
 * integration from one that quietly destroys edits. These prove it: an inbound
 * status change mirrors onto the task per the configured map, attributed to the
 * integration (AC2); but when the task has *also* changed locally since the
 * last sync, neither side is overwritten and the link enters `conflict` (AC3).
 */

function fakeTrackerSink(): TrackerSink & { readonly transitions: Array<{ toExternalStatus: string }> } {
  let n = 0
  const transitions: Array<{ toExternalStatus: string }> = []
  return {
    transitions,
    async createIssue() {
      n += 1
      return { externalId: `ext-${n}`, key: `ACME-${n}`, url: `https://x.test/${n}` } satisfies ExternalRef
    },
    async updateIssue({ externalId }) {
      return { externalId }
    },
    async transition({ externalId, toExternalStatus }) {
      transitions.push({ toExternalStatus })
      return { externalId }
    },
  }
}

describe('TASK-4 inbound status mirror and conflict', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    app = createApp({ dbConfig: db.config, mailer, trackerSink: fakeTrackerSink() })
    client = createTestClient(app, mailer)
  })

  const sync = () =>
    createTaskSyncService(db.config, { tasks: createTaskService(db.config), sink: fakeTrackerSink() })

  async function pushedTask(statusMap: Record<string, string>) {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Sync')
    const [team] = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{ id: string }>
    const integrationId = ulid()
    await db.admin.execute(
      `INSERT INTO integrations (id, workspace_id, kind, config) VALUES ($1, $2, 'linear', $3::jsonb)`,
      [integrationId, workspace.id, JSON.stringify({ statusMap })],
    )
    const task = (await (
      await ada.post(`/workspaces/${workspace.id}/teams/${team!.id}/tasks`, { title: 'Parser' })
    ).json()) as { id: string }
    const link = (await (
      await ada.post(`/workspaces/${workspace.id}/tasks/${task.id}/push`)
    ).json()) as { externalId: string }
    return { ada, workspaceId: workspace.id, teamId: team!.id, integrationId, task, link }
  }

  it('TASK-4: an inbound status change mirrors onto the task, attributed to the integration', async () => {
    const w = await pushedTask({ todo: 'Todo', in_progress: 'In Progress', done: 'Done' })

    const outcome = await sync().mirrorInbound({
      workspaceId: w.workspaceId,
      integrationId: w.integrationId,
      externalId: w.link.externalId,
      externalStatus: 'In Progress',
    })
    expect(outcome.result).toBe('mirrored')

    // The task moved per the map.
    const task = (await (await w.ada.get(`/workspaces/${w.workspaceId}/tasks/${w.task.id}`)).json()) as {
      status: string
    }
    expect(task.status).toBe('in_progress')

    // Attributed to the integration, not a user (AC2).
    const audit = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/audit?targetId=${w.task.id}`)
    ).json()) as { entries: Array<{ action: string; actorType: string }> }
    expect(audit.entries).toContainEqual(
      expect.objectContaining({ action: 'task.sync_status', actorType: 'integration' }),
    )
  })

  it('TASK-4: simultaneous edits on both sides produce a conflict, and neither side is overwritten (AC3)', async () => {
    const w = await pushedTask({ todo: 'Todo', in_progress: 'In Progress', done: 'Done' })

    // Local edit since the last sync.
    await w.ada.patch(`/workspaces/${w.workspaceId}/tasks/${w.task.id}`, { title: 'Parser, split out' })

    // And a remote status change arrives.
    const outcome = await sync().mirrorInbound({
      workspaceId: w.workspaceId,
      integrationId: w.integrationId,
      externalId: w.link.externalId,
      externalStatus: 'Done',
    })
    expect(outcome.result).toBe('conflict')

    // Neither side overwritten: the task keeps its local status and title.
    const task = (await (await w.ada.get(`/workspaces/${w.workspaceId}/tasks/${w.task.id}`)).json()) as {
      status: string
      title: string
    }
    expect(task.status, 'the remote status did not overwrite the local one').toBe('todo')
    expect(task.title).toBe('Parser, split out')

    // The link is marked conflict.
    const [row] = await db.admin.query<{ sync_state: string }>(
      `SELECT sync_state FROM task_tracker_links WHERE task_id = $1`,
      [w.task.id],
    )
    expect(row?.sync_state).toBe('conflict')
  })

  it('TASK-4: transitioning out with no mapping for the task’s status is refused by name (AC5)', async () => {
    // The task is `todo`, and the map has no entry for it.
    const w = await pushedTask({ in_progress: 'In Progress', done: 'Done' })

    const response = await w.ada.post(`/workspaces/${w.workspaceId}/tasks/${w.task.id}/transition`)
    expect(response.status).toBe(400)
    expect(await response.text(), 'the refusal names the missing status').toMatch(/todo/i)
  })

  it('TASK-4: transitioning out with a mapped status pushes it to the tracker', async () => {
    const w = await pushedTask({ todo: 'Todo', done: 'Done' })

    const response = await w.ada.post(`/workspaces/${w.workspaceId}/tasks/${w.task.id}/transition`)
    expect(response.status, await response.clone().text()).toBe(200)
    const body = (await response.json()) as { toExternalStatus: string }
    expect(body.toExternalStatus).toBe('Todo')
  })

  it('TASK-4: an inbound status with no mapping is left for a human, not guessed', async () => {
    const w = await pushedTask({ todo: 'Todo', done: 'Done' })

    const outcome = await sync().mirrorInbound({
      workspaceId: w.workspaceId,
      integrationId: w.integrationId,
      externalId: w.link.externalId,
      externalStatus: 'In Review',
    })
    expect(outcome.result).toBe('unmapped')

    const task = (await (await w.ada.get(`/workspaces/${w.workspaceId}/tasks/${w.task.id}`)).json()) as {
      status: string
    }
    expect(task.status, 'an unmapped status must not move the task').toBe('todo')
  })
})
