import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { ulid } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { loadPromptDirectory } from '@chorus/llm'
import { createFakeModelProvider } from '@chorus/testing'
import { createEntityStore, createLlmExtractor } from '../../src/index.js'

/**
 * BRAIN-3 — the LLM extraction pass, against a real database.
 *
 * The model reads a signal's text and proposes entities and edges; each lands
 * with a character span that resolves to the source (AC2), and the call's spend
 * is recorded (AC6). What it proposes is resolved by the ingestor, so a
 * candidate matching nothing becomes a new entity here.
 */
const PROMPTS = loadPromptDirectory(
  join(import.meta.dirname, '..', '..', '..', '..', 'workflows', 'prompts'),
)

describe('BRAIN-3 LLM extraction', () => {
  let db: IsolatedDatabase

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  async function workspaceWithSignal(): Promise<{ workspaceId: string; signalId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM brain_review_items WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM entities WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    const [integration] = await db.admin.query<{ id: string }>(
      `SELECT id FROM integrations WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    const signalId = ulid()
    await db.admin.execute(
      `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions)
       VALUES ($1, $2, $3, 'linear', 'ACME-7', 'issue', 'The deploy step times out.', now(),
               '{"visibility":"public","scopeIds":[]}'::jsonb)`,
      [signalId, workspaceId, integration!.id],
    )
    return { workspaceId, signalId }
  }

  it('BRAIN-3 AC2/AC6: the model pass lands entities with span evidence and records spend', async () => {
    const { workspaceId, signalId } = await workspaceWithSignal()
    const models = createFakeModelProvider()
    models.script({
      structured: {
        entities: [
          { kind: 'ticket', name: 'The deploy step times out', aliases: ['ACME-7'], charStart: 0, charEnd: 25 },
        ],
        edges: [],
      },
    })
    const store = createEntityStore(db.config)
    const extractor = createLlmExtractor({
      config: db.config,
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      prompt: PROMPTS.get('brain/extract'),
    })

    const outcome = await extractor.extract({
      workspaceId,
      signalId,
      signalExternalId: 'ACME-7',
      source: 'linear',
      text: 'The deploy step times out.',
      extractorVersion: 1,
    })

    // The model was called once, and produced the entity.
    expect(models.requests()).toHaveLength(1)
    expect(outcome.created).toBe(1)
    const entities = await store.list(workspaceId)
    expect(entities.map((e) => e.name)).toContain('The deploy step times out')

    // Its evidence carries the character span the model cited (AC2).
    const [evidence] = await db.admin.query<{ char_start: number | null; char_end: number | null }>(
      `SELECT char_start, char_end FROM entity_evidence WHERE workspace_id = $1 AND signal_id = $2`,
      [workspaceId, signalId],
    )
    expect(evidence).toMatchObject({ char_start: 0, char_end: 25 })

    // The call's spend is recorded against the extract purpose (AC6).
    const [spend] = await db.admin.query<{ purpose: string }>(
      `SELECT purpose FROM spend_ledger WHERE workspace_id = $1 ORDER BY at DESC LIMIT 1`,
      [workspaceId],
    )
    expect(spend?.purpose).toBe('extract')
  })

  it('BRAIN-3 AC4: re-running the pass over the same signal makes no duplicate entities', async () => {
    const { workspaceId, signalId } = await workspaceWithSignal()
    const models = createFakeModelProvider()
    const script = {
      structured: {
        entities: [{ kind: 'ticket', name: 'The deploy step times out', aliases: [], charStart: 0, charEnd: 25 }],
        edges: [],
      },
    }
    const extractor = () =>
      createLlmExtractor({
        config: db.config,
        models,
        modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
        prompt: PROMPTS.get('brain/extract'),
      })

    models.script(script)
    await extractor().extract({
      workspaceId,
      signalId,
      signalExternalId: 'ACME-7',
      source: 'linear',
      text: 'The deploy step times out.',
      extractorVersion: 1,
    })
    models.script(script)
    await extractor().extract({
      workspaceId,
      signalId,
      signalExternalId: 'ACME-7',
      source: 'linear',
      text: 'The deploy step times out.',
      extractorVersion: 1,
    })

    expect(await createEntityStore(db.config).list(workspaceId)).toHaveLength(1)
  })
})
