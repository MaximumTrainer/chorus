import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid } from '@chorus/core'
import { createFakeModelProvider } from '@chorus/testing'
import { createSignalEmbedder } from '../../src/index.js'

/**
 * BRAIN-1 AC6 — embedding is cached by content hash; AC2 — a re-run computes
 * no new embeddings.
 *
 * Signals are immutable (AC3), so their vectors are not written onto them: a
 * workspace-scoped cache holds one vector per (model, hash of the text), and a
 * signal finds its vector by its text's hash. Unchanged content therefore never
 * costs a provider call — not on a re-run, not for a new version that only
 * changed who may see it, not for a revert, not for two items that say the same
 * thing. The cache is per workspace, so a hit can never reveal that another
 * tenant holds the same words; and the model is part of the key, because one
 * model's vector is meaningless to another.
 */
describe('BRAIN-1 signal embeddings', () => {
  let db: IsolatedDatabase
  const models = createFakeModelProvider()

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  /** A counting embedder: what the provider would have been asked, call by call. */
  function counting() {
    const calls: string[][] = []
    const embed = async (texts: readonly string[]) => {
      calls.push([...texts])
      return texts.map((t) => models.embedText(t))
    }
    return { calls, embed }
  }

  async function world() {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    for (const table of ['signals', 'embedding_cache']) {
      await db.admin.execute(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId])
    }
    const [integration] = await db.admin.query<{ id: string }>(
      `SELECT id FROM integrations WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    const signal = async (externalId: string, text: string, permissions: unknown, supersedes: string | null = null) => {
      const id = ulid()
      await db.admin.execute(
        `INSERT INTO signals
           (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions, supersedes_id)
         VALUES ($1, $2, $3, 'reference', $4, 'page', $5, now(), $6::jsonb, $7)`,
        [id, workspaceId, integration!.id, externalId, text, JSON.stringify(permissions), supersedes],
      )
      return id
    }
    return { workspaceId, signal }
  }

  const PUBLIC = { visibility: 'public', scopeIds: [] }
  const RESTRICTED = { visibility: 'restricted', scopeIds: ['room-1'] }

  it('BRAIN-1 AC6: each distinct text is embedded once', async () => {
    const w = await world()
    await w.signal('a', 'the deploy timed out', PUBLIC)
    await w.signal('b', 'the invoice was late', PUBLIC)
    await w.signal('c', 'the deploy timed out', PUBLIC) // same words, different item
    const { calls, embed } = counting()

    const outcome = await createSignalEmbedder(db.config, { embed, model: 'fake-embed' }).embedPending(w.workspaceId)

    expect(outcome.computed).toBe(2)
    expect(calls.flat().sort()).toEqual(['the deploy timed out', 'the invoice was late'])
  })

  it('BRAIN-1 AC6: a new version with unchanged text — a permission change — is a cache hit, not a provider call', async () => {
    const w = await world()
    const v1 = await w.signal('a', 'the forecast is strong', PUBLIC)
    const first = counting()
    await createSignalEmbedder(db.config, { embed: first.embed, model: 'fake-embed' }).embedPending(w.workspaceId)

    await w.signal('a', 'the forecast is strong', RESTRICTED, v1)
    const second = counting()
    const outcome = await createSignalEmbedder(db.config, { embed: second.embed, model: 'fake-embed' }).embedPending(
      w.workspaceId,
    )

    expect(outcome.computed).toBe(0)
    expect(second.calls).toEqual([])
  })

  it('BRAIN-1 AC2: a re-run with nothing new computes nothing', async () => {
    const w = await world()
    await w.signal('a', 'nothing changes', PUBLIC)
    await createSignalEmbedder(db.config, { embed: counting().embed, model: 'fake-embed' }).embedPending(w.workspaceId)

    const again = counting()
    const outcome = await createSignalEmbedder(db.config, { embed: again.embed, model: 'fake-embed' }).embedPending(
      w.workspaceId,
    )
    expect(outcome.computed).toBe(0)
    expect(again.calls).toEqual([])
  })

  it('BRAIN-1 AC6: the cache is per workspace, so a hit never reveals another tenant holds the same words', async () => {
    const a = await world()
    const b = await world()
    await a.signal('x', 'a shared sentence', PUBLIC)
    await b.signal('y', 'a shared sentence', PUBLIC)
    await createSignalEmbedder(db.config, { embed: counting().embed, model: 'fake-embed' }).embedPending(a.workspaceId)

    const forB = counting()
    await createSignalEmbedder(db.config, { embed: forB.embed, model: 'fake-embed' }).embedPending(b.workspaceId)
    expect(forB.calls.flat()).toEqual(['a shared sentence'])
  })

  it('BRAIN-1 AC6: the model is part of the key', async () => {
    const w = await world()
    await w.signal('a', 'same words, new model', PUBLIC)
    await createSignalEmbedder(db.config, { embed: counting().embed, model: 'model-one' }).embedPending(w.workspaceId)

    const next = counting()
    const outcome = await createSignalEmbedder(db.config, { embed: next.embed, model: 'model-two' }).embedPending(
      w.workspaceId,
    )
    expect(outcome.computed).toBe(1)
    expect(next.calls.flat()).toEqual(['same words, new model'])
  })
})
