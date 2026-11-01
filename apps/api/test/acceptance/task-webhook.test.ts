import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ulid, type ExternalRef } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import type { TrackerSink } from '../../src/task-push.js'
import type { TrackerWebhook, TrackerDelivery } from '../../src/tracker-webhook.js'
import { createRecordingMailer, createTestClient, type TestClient } from '@chorus/testing'

/**
 * TASK-4 — the inbound webhook mounts onto the mirror (AC2, end to end).
 *
 * The mirror logic is proven in task-sync; this proves the public webhook route
 * feeds it: a processed delivery carrying an issue's new status moves the
 * mapped task, so a status change made in the tracker shows up in Chorus
 * without anyone asking. The gateway that verifies and resolves the delivery is
 * faked here — its internals are the connector receiver's, proven in INT-1.
 */

function fakeTrackerSink(): TrackerSink {
  let n = 0
  return {
    async createIssue() {
      n += 1
      return { externalId: `ext-${n}`, key: `ACME-${n}`, url: `https://x.test/${n}` } satisfies ExternalRef
    },
    async updateIssue({ externalId }) {
      return { externalId }
    },
    async transition({ externalId }) {
      return { externalId }
    },
  }
}

/** A gateway that verifies nothing and reports a scripted delivery. */
function fakeWebhook(next: () => TrackerDelivery): TrackerWebhook {
  return { async handle() { return next() } }
}

describe('TASK-4 inbound webhook mirrors onto the task', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let delivery: TrackerDelivery

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    const app = createApp({
      dbConfig: db.config,
      mailer,
      trackerSink: fakeTrackerSink(),
      trackerWebhook: fakeWebhook(() => delivery),
    })
    client = createTestClient(app, mailer)
  })

  it('TASK-4: a processed delivery moves the mapped task per the status map', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Webhook')
    const [team] = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{ id: string }>
    const integrationId = ulid()
    await db.admin.execute(
      `INSERT INTO integrations (id, workspace_id, kind, config) VALUES ($1, $2, 'linear', $3::jsonb)`,
      [integrationId, workspace.id, JSON.stringify({ statusMap: { todo: 'Todo', done: 'Done' } })],
    )
    const task = (await (
      await ada.post(`/workspaces/${workspace.id}/teams/${team!.id}/tasks`, { title: 'Parser' })
    ).json()) as { id: string }
    const link = (await (await ada.post(`/workspaces/${workspace.id}/tasks/${task.id}/push`)).json()) as {
      externalId: string
    }

    // The tracker reports the issue moved to Done.
    delivery = {
      state: 'processed',
      workspaceId: workspace.id,
      changes: [{ externalId: link.externalId, externalStatus: 'Done' }],
    }

    const response = await client.anonymous().post(`/webhooks/${integrationId}`, { any: 'payload' })
    expect(response.status, await response.clone().text()).toBe(200)
    const body = (await response.json()) as { mirrored: Array<{ result: string }> }
    expect(body.mirrored).toEqual([expect.objectContaining({ result: 'mirrored' })])

    // The task moved per the map.
    const read = (await (await ada.get(`/workspaces/${workspace.id}/tasks/${task.id}`)).json()) as {
      status: string
    }
    expect(read.status).toBe('done')
  })
})
