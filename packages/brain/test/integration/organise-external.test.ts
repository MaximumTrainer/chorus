import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { ulid, type EntityCandidate } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { loadPromptDirectory } from '@chorus/llm'
import { createFakeModelProvider } from '@chorus/testing'
import {
  createEntityStore,
  createMergeDetector,
  createStaleDetector,
  createContradictionDetector,
} from '../../src/index.js'

/**
 * BRAIN-11 AC3 — self-organisation leaves external-authority entities alone.
 *
 * Merge, split and contradiction never target them; only the source's own
 * freshness — `last_synced_at` older than the expected cadence — may mark one
 * stale.
 */
const PROMPTS = loadPromptDirectory(join(import.meta.dirname, '..', '..', '..', '..', 'workflows', 'prompts'))

describe('BRAIN-11 self-organisation and external authority (AC3)', () => {
  let db: IsolatedDatabase

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  async function workspace(): Promise<{ workspaceId: string; signalId: string; integrationId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM brain_review_items WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM entities WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    const integrationId = (
      await db.admin.query<{ id: string }>(`SELECT id FROM integrations WHERE workspace_id = $1 LIMIT 1`, [workspaceId])
    )[0]!.id
    const signalId = ulid()
    await db.admin.execute(
      `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions)
       VALUES ($1, $2, $3, 'reference', $1, 'issue', 'x', now(), '{"visibility":"public","scopeIds":[]}'::jsonb)`,
      [signalId, workspaceId, integrationId],
    )
    return { workspaceId, signalId, integrationId }
  }

  const entity = (over: Partial<EntityCandidate> & { externalId: string; name: string }): EntityCandidate => ({
    kind: 'feature',
    aliases: [],
    attributes: {},
    evidence: { signalExternalId: 'sig', source: 'reference' },
    ...over,
  })

  it('BRAIN-11 AC3: the merge detector never proposes merging external entities', async () => {
    const { workspaceId, signalId } = await workspace()
    const store = createEntityStore(db.config)
    // Two similarly-named external services — tempting to merge, but the graph owns them.
    for (const [id, name] of ([['payments', 'payments'], ['payment', 'payment']] as [string, string][])) {
      await store.upsertCandidate({
        workspaceId,
        candidate: entity({ kind: 'service', externalId: `sdlckg:Service:${id}`, name, authority: 'external', externalUri: `sdlckg://Service/${id}` }),
        signalId,
        extractorVersion: 1,
      })
    }
    // Control: two similarly-named brain features.
    for (const [id, name] of ([['f-a', 'billing'], ['f-b', 'billings']] as [string, string][])) {
      await store.upsertCandidate({ workspaceId, candidate: entity({ externalId: id, name }), signalId, extractorVersion: 1 })
    }

    const { proposed } = await createMergeDetector(db.config).detect(workspaceId)
    const items = await store.reviewItems(workspaceId)
    // Only the brain pair is proposed; neither external service is in any item.
    expect(proposed).toBe(1)
    const named = JSON.stringify(items)
    expect(named).not.toContain('payments')
    expect(named).not.toContain('payment')
  })

  it('BRAIN-11 AC3: an external entity unsynced past its cadence is stale (by freshness only)', async () => {
    const { workspaceId, signalId } = await workspace()
    const store = createEntityStore(db.config)
    const { entityId } = await store.upsertCandidate({
      workspaceId,
      candidate: entity({ kind: 'service', externalId: 'sdlckg:Service:old', name: 'legacy', authority: 'external', externalUri: 'sdlckg://Service/legacy' }),
      signalId,
      extractorVersion: 1,
    })
    // Backdate its last sync beyond the cadence.
    await db.admin.execute(`UPDATE entities SET last_synced_at = now() - interval '40 days' WHERE id = $1`, [entityId])

    const { proposed } = await createStaleDetector(db.config, { externalStaleAfterDays: 7 }).detect(workspaceId)
    expect(proposed).toBe(1)
    const [item] = await store.reviewItems(workspaceId)
    expect(item).toMatchObject({ kind: 'stale', subject: { detector: 'external-freshness' } })
  })

  it('BRAIN-11 AC3: a freshly-synced external entity is not stale', async () => {
    const { workspaceId, signalId } = await workspace()
    const store = createEntityStore(db.config)
    await store.upsertCandidate({
      workspaceId,
      candidate: entity({ kind: 'environment', externalId: 'sdlckg:Environment:prod', name: 'prod', authority: 'external', externalUri: 'sdlckg://Environment/prod' }),
      signalId,
      extractorVersion: 1,
    })
    const { proposed } = await createStaleDetector(db.config, { externalStaleAfterDays: 7 }).detect(workspaceId)
    expect(proposed).toBe(0)
  })

  it('BRAIN-11 AC3: the contradiction detector never targets an external entity', async () => {
    const { workspaceId, integrationId } = await workspace()
    const store = createEntityStore(db.config)
    const s1 = ulid()
    const s2 = ulid()
    for (const [id, text] of ([[s1, 'prod is in eu-west'], [s2, 'prod is in us-east']] as [string, string][])) {
      await db.admin.execute(
        `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions)
         VALUES ($1, $2, $3, 'reference', $1, 'issue', $4, now(), '{"visibility":"public","scopeIds":[]}'::jsonb)`,
        [id, workspaceId, integrationId, text],
      )
    }
    await store.upsertCandidate({
      workspaceId,
      candidate: entity({ kind: 'environment', externalId: 'sdlckg:Environment:prod', name: 'prod', authority: 'external', externalUri: 'sdlckg://Environment/prod' }),
      signalId: s1,
      extractorVersion: 1,
    })
    await store.upsertCandidate({
      workspaceId,
      candidate: entity({ kind: 'environment', externalId: 'sdlckg:Environment:prod', name: 'prod', authority: 'external', externalUri: 'sdlckg://Environment/prod' }),
      signalId: s2,
      extractorVersion: 1,
    })

    const models = createFakeModelProvider()
    // Scripted to contradict if it were ever asked — but it must not be, so no item appears.
    models.script({ structured: { contradictions: [{ aSignalExternalId: s1, bSignalExternalId: s2, reason: 'different regions' }] } })

    const { proposed } = await createContradictionDetector({
      config: db.config,
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      prompt: PROMPTS.get('brain/contradiction'),
    }).detect(workspaceId)

    expect(proposed).toBe(0)
    expect(models.requests, 'the model is never consulted for an external entity').toHaveLength(0)
  })
})
