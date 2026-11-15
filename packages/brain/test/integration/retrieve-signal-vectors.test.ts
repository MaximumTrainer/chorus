import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid } from '@chorus/core'
import { createFakeModelProvider } from '@chorus/testing'
import { createRetriever, createSignalEmbedder } from '../../src/index.js'

/**
 * BRAIN-4 / BRAIN-1 AC6 — the vector half of signal retrieval.
 *
 * Embedded signals are found by meaning as well as by term, fused the way code
 * is. The vector search runs over the workspace's embedding cache and joins
 * back to signals by content hash, so the same two rules as the lexical half
 * hold inside the query: only a signal the caller may see, and only an item's
 * current version.
 */
describe('BRAIN-4 signal retrieval by vector', () => {
  let db: IsolatedDatabase
  const models = createFakeModelProvider()
  const MODEL = { provider: 'fake', model: 'fake-embed' }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  async function world() {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    for (const table of ['signals', 'embedding_cache', 'source_scope_memberships']) {
      await db.admin.execute(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId])
    }
    const [owner] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    const [team] = await db.admin.query<{ id: string }>(`SELECT id FROM teams WHERE workspace_id = $1 LIMIT 1`, [
      workspaceId,
    ])
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
    const embedAll = () =>
      createSignalEmbedder(db.config, {
        embed: async (texts) => texts.map((t) => models.embedText(t)),
        model: MODEL.model,
      }).embedPending(workspaceId)
    const search = async (query: string) =>
      (
        await createRetriever(db.config, { models, embeddingModel: MODEL }).retrieve({
          workspaceId,
          teamId: team!.id,
          userId: owner!.user_id,
          query,
          kinds: ['signal'],
        })
      ).fragments
    return { signal, embedAll, search }
  }

  const PUBLIC = { visibility: 'public', scopeIds: [] }

  it('BRAIN-4: an embedded signal is found by its vector as well as its terms', async () => {
    const w = await world()
    await w.signal('a', 'validate the session cookie and reject expired tokens', PUBLIC)
    await w.signal('b', 'parse comma separated values into rows', PUBLIC)
    await w.embedAll()

    const [top] = await w.search('session cookie expired')
    expect(top!.text).toContain('session cookie')
    expect(top!.sources).toEqual(expect.arrayContaining(['lexical', 'vector']))
  })

  it('BRAIN-4 AC2: the vector half never returns a signal the caller may not see', async () => {
    const w = await world()
    await w.signal('a', 'the quarterly forecast for finance', { visibility: 'restricted', scopeIds: ['finance'] })
    await w.embedAll()

    expect(await w.search('quarterly forecast finance')).toEqual([])
  })

  it('BRAIN-1 AC3: the vector half returns only an item’s current version', async () => {
    const w = await world()
    const v1 = await w.signal('a', 'deploy freeze starts friday', PUBLIC)
    await w.signal('a', 'deploy freeze is lifted', PUBLIC, v1)
    await w.embedAll()

    expect((await w.search('deploy freeze friday')).map((f) => f.text)).toEqual(['deploy freeze is lifted'])
  })
})
