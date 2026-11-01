import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { ulid, type EntityCandidate } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { loadPromptDirectory } from '@chorus/llm'
import { createFakeModelProvider } from '@chorus/testing'
import { createContradictionDetector, createEntityStore } from '../../src/index.js'

/**
 * BRAIN-7 AC5 — contradictions are surfaced with both claims.
 *
 * Two high-trust signals making conflicting claims about one entity produce a
 * `contradiction` review item that shows both claims and their sources, with
 * neither silently preferred. A hallucinated pair that names no real source is
 * ignored.
 */
const PROMPTS = loadPromptDirectory(
  join(import.meta.dirname, '..', '..', '..', '..', 'workflows', 'prompts'),
)

describe('BRAIN-7 contradiction detection', () => {
  let db: IsolatedDatabase

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  const entity = (over: Partial<EntityCandidate> & { externalId: string; name: string }): EntityCandidate => ({
    kind: 'feature',
    aliases: [],
    attributes: {},
    evidence: { signalExternalId: 'sig', source: 'linear' },
    ...over,
  })

  async function setup() {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM brain_review_items WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM entities WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    const [integration] = await db.admin.query<{ id: string }>(
      `SELECT id FROM integrations WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    const store = createEntityStore(db.config)

    // Two signals making opposite claims, both evidence for one entity.
    const entityId = (
      await store.upsertCandidate({
        workspaceId,
        candidate: entity({ externalId: 'e:gateway', name: 'Payments Gateway' }),
        signalId: await addSignal(workspaceId, integration!.id, 'gw-dep', 'The Payments Gateway is deprecated.'),
        extractorVersion: 1,
      })
    ).entityId
    await store.upsertCandidate({
      workspaceId,
      candidate: entity({ externalId: 'e:gateway', name: 'Payments Gateway' }),
      signalId: await addSignal(workspaceId, integration!.id, 'gw-rec', 'The Payments Gateway is the recommended path.'),
      extractorVersion: 1,
    })
    return { workspaceId, store, entityId }
  }

  async function addSignal(workspaceId: string, integrationId: string, externalId: string, text: string) {
    const id = ulid()
    await db.admin.execute(
      `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions)
       VALUES ($1, $2, $3, 'linear', $4, 'issue', $5, now(), '{"visibility":"public","scopeIds":[]}'::jsonb)`,
      [id, workspaceId, integrationId, externalId, text],
    )
    return id
  }

  it('BRAIN-7 AC5: conflicting claims produce a contradiction item showing both', async () => {
    const { workspaceId, store, entityId } = await setup()
    const models = createFakeModelProvider()
    models.script({
      structured: {
        contradictions: [{ aSignalExternalId: 'gw-dep', bSignalExternalId: 'gw-rec', reason: 'deprecated vs recommended' }],
      },
    })

    const outcome = await createContradictionDetector({
      config: db.config,
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      prompt: PROMPTS.get('brain/contradiction'),
    }).detect(workspaceId)

    expect(outcome.proposed).toBe(1)
    const [item] = await store.reviewItems(workspaceId)
    expect(item).toMatchObject({
      kind: 'contradiction',
      subject: {
        entity: { entityId },
        claimA: { signalExternalId: 'gw-dep', text: 'The Payments Gateway is deprecated.' },
        claimB: { signalExternalId: 'gw-rec', text: 'The Payments Gateway is the recommended path.' },
      },
    })
    // Spend was recorded for the pass (AC7).
    const [spend] = await db.admin.query<{ purpose: string }>(
      `SELECT purpose FROM spend_ledger WHERE workspace_id = $1 ORDER BY at DESC LIMIT 1`,
      [workspaceId],
    )
    expect(spend?.purpose).toBe('classify')
  })

  it('BRAIN-7 AC5: a pair naming a signal that was not among the claims is ignored', async () => {
    const { workspaceId, store } = await setup()
    const models = createFakeModelProvider()
    models.script({
      structured: {
        contradictions: [{ aSignalExternalId: 'gw-dep', bSignalExternalId: 'ghost', reason: 'hallucinated' }],
      },
    })

    const outcome = await createContradictionDetector({
      config: db.config,
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      prompt: PROMPTS.get('brain/contradiction'),
    }).detect(workspaceId)

    expect(outcome.proposed).toBe(0)
    expect(await store.reviewItems(workspaceId)).toHaveLength(0)
  })
})
