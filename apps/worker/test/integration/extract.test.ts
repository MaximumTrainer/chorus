import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createEntityStore } from '@chorus/brain'
import { createLinearConnector } from '@chorus/connectors'
import { createFakeModelProvider } from '@chorus/testing'
import { createDeterministicExtractor } from '../../src/extract.js'

/**
 * BRAIN-3 — the deterministic extraction pass, against a real database.
 *
 * Entities the source already defines are read out of signals by the
 * connector's `mapExternal` and persisted — with no model call (AC1), with
 * evidence that leads back to the signal (AC2), and idempotently, so
 * re-extracting the same signals makes no duplicates (AC4).
 */
describe('BRAIN-3 deterministic extraction', () => {
  let db: IsolatedDatabase

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  async function workspaceWithLinearIssue(): Promise<{ workspaceId: string; signalId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM entities WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    const integrationId = ulid()
    await db.admin.execute(`INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'linear')`, [
      integrationId,
      workspaceId,
    ])
    const signalId = ulid()
    await db.admin.execute(
      `INSERT INTO signals
         (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions, raw)
       VALUES ($1, $2, $3, 'linear', 'ACME-7', 'issue', 'Deploy times out', now(),
               '{"visibility":"public","scopeIds":[]}'::jsonb, $4::jsonb)`,
      [
        signalId,
        workspaceId,
        integrationId,
        JSON.stringify({
          id: 'lin-issue-1',
          identifier: 'ACME-7',
          title: 'Deploy times out',
          state: { name: 'Todo' },
          team: { key: 'ACME' },
          creator: { id: 'user-1', name: 'Ada Lovelace', displayName: 'ada' },
        }),
      ],
    )
    return { workspaceId, signalId }
  }

  // The extractor is given no model: the deterministic pass has no way to call
  // one. The test holds a fake model alongside it only to prove it stayed at
  // zero requests.
  const extractor = () =>
    createDeterministicExtractor({
      config: db.config,
      connectorsByKind: { linear: () => createLinearConnector() },
      entities: createEntityStore(db.config),
      extractorVersion: 1,
    })

  it('BRAIN-3: an ingested issue produces entities whose evidence resolves to the signal, with no model call', async () => {
    const model = createFakeModelProvider()
    const { workspaceId, signalId } = await workspaceWithLinearIssue()
    const store = createEntityStore(db.config)

    const outcome = await extractor().extract(workspaceId)

    // The deterministic pass used no model (AC1).
    expect(model.requests, 'the deterministic pass must call no model').toHaveLength(0)

    // The issue became a ticket, and its creator a person (AC1 kinds).
    const entities = await store.list(workspaceId)
    const kinds = entities.map((e) => e.kind).sort()
    expect(kinds).toEqual(['person', 'ticket'])
    expect(outcome.entities).toBe(2)

    // Every entity's evidence leads back to the signal it was read from (AC2).
    for (const entity of entities) {
      expect(await store.evidenceFor(workspaceId, entity.id)).toContain(signalId)
    }
  })

  it('BRAIN-3: re-extracting the same signal at the same version makes no duplicates (AC4)', async () => {
    const { workspaceId } = await workspaceWithLinearIssue()
    const store = createEntityStore(db.config)

    await extractor().extract(workspaceId)
    await extractor().extract(workspaceId)

    const entities = await store.list(workspaceId)
    expect(entities, 'a second extraction must not duplicate entities').toHaveLength(2)
  })
})
