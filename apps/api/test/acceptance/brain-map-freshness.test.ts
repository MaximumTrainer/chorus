import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ulid, type EntityCandidate } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createBrainMap, createEntityStore } from '@chorus/brain'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type TestClient } from '@chorus/testing'

/**
 * BRAIN-6 AC3 — freshness is visible, and its definition is documented.
 *
 * Every node carries a freshness class the client can style, and the map
 * carries the definition of "stale" it was classified against, so the UI can
 * show the reader what the distinction means rather than leaving it implicit.
 */
interface BrainMap {
  nodes: Array<{ name: string; freshness: 'fresh' | 'stale' | 'unknown' }>
  freshness: { staleAfterDays: number; definition: string }
}

describe('BRAIN-6 map freshness', () => {
  const NOW = new Date('2026-11-13T12:00:00Z')
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
    // The clock is frozen, so "stale" is decided against a fixed instant.
    const brainMap = createBrainMap(db.config, { now: () => NOW })
    client = createTestClient(createApp({ dbConfig: db.config, mailer, brainMap }), mailer)
  })

  const candidate = (over: Partial<EntityCandidate> & { externalId: string; name: string }): EntityCandidate => ({
    kind: 'feature',
    aliases: [],
    attributes: {},
    evidence: { signalExternalId: 'sig', source: 'reference' },
    ...over,
  })

  it('BRAIN-6 AC3: recent and stale entities are distinguished, and stale is defined', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Fresh')
    const integrationId = ulid()
    await db.admin.execute(`INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'jira')`, [
      integrationId,
      workspace.id,
    ])
    const signalAt = async (at: Date) => {
      const id = ulid()
      await db.admin.execute(
        `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions)
         VALUES ($1, $2, $3, 'jira', $1, 'issue', 'x', $4, '{"visibility":"public","scopeIds":[]}'::jsonb)`,
        [id, workspace.id, integrationId, at],
      )
      return id
    }
    const day = 24 * 60 * 60 * 1000
    const store = createEntityStore(db.config)
    await store.upsertCandidate({
      workspaceId: workspace.id,
      candidate: candidate({ externalId: 'e:recent', name: 'recent' }),
      signalId: await signalAt(new Date(NOW.getTime() - 2 * day)),
      extractorVersion: 1,
    })
    await store.upsertCandidate({
      workspaceId: workspace.id,
      candidate: candidate({ externalId: 'e:old', name: 'old' }),
      signalId: await signalAt(new Date(NOW.getTime() - 100 * day)),
      extractorVersion: 1,
    })

    const res = await ada.get(`/workspaces/${workspace.id}/brain/map`)
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as BrainMap

    const byName = Object.fromEntries(body.nodes.map((n) => [n.name, n.freshness]))
    expect(byName).toEqual({ recent: 'fresh', old: 'stale' })
    // The definition travels with the data, for the UI to document.
    expect(body.freshness.staleAfterDays).toBe(30)
    expect(body.freshness.definition).toMatch(/30 days/)
  })
})
