import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid, ValidationError, type EntityCandidate } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createEntityStore } from '../../src/index.js'

/**
 * BRAIN-11 AC1 — operational kinds are stored with external authority, and a
 * brain-authored one is refused with a typed error.
 */
describe('BRAIN-11 entity authority at the store (AC1)', () => {
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
    await db.admin.execute(`DELETE FROM entities WHERE workspace_id = $1`, [workspaceId])
    const integrationId = (
      await db.admin.query<{ id: string }>(`SELECT id FROM integrations WHERE workspace_id = $1 LIMIT 1`, [workspaceId])
    )[0]!.id
    const signalId = ulid()
    await db.admin.execute(
      `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions, raw)
       VALUES ($1, $2, $3, 'reference', 's:1', 'node.upserted', 'x', now(), '{"visibility":"public","scopeIds":[]}'::jsonb, '{}'::jsonb)`,
      [signalId, workspaceId, integrationId],
    )
    return { workspaceId, signalId }
  }

  const candidate = (over: Partial<EntityCandidate>): EntityCandidate => ({
    kind: 'ticket',
    externalId: 'jira:issue:X',
    name: 'X',
    aliases: [],
    attributes: {},
    evidence: { signalExternalId: 's:1', source: 'reference' },
    ...over,
  })

  it('BRAIN-11 AC1: a brain kind is stored with brain authority and no external uri', async () => {
    const { workspaceId, signalId } = await workspaceWithSignal()
    const store = createEntityStore(db.config)
    const { entityId } = await store.upsertCandidate({ workspaceId, candidate: candidate({}), signalId, extractorVersion: 1 })

    const [row] = await db.admin.query<{ authority: string; external_uri: string | null }>(
      `SELECT authority, external_uri FROM entities WHERE id = $1`,
      [entityId],
    )
    expect(row!.authority).toBe('brain')
    expect(row!.external_uri).toBeNull()
  })

  it('BRAIN-11 AC1: an operational kind with a uri is stored external, with last_synced_at set', async () => {
    const { workspaceId, signalId } = await workspaceWithSignal()
    const store = createEntityStore(db.config)
    const { entityId } = await store.upsertCandidate({
      workspaceId,
      candidate: candidate({
        kind: 'service',
        externalId: 'sdlckg:Service:checkout',
        name: 'checkout',
        authority: 'external',
        externalUri: 'sdlckg://Service/checkout',
      }),
      signalId,
      extractorVersion: 1,
    })

    const [row] = await db.admin.query<{ authority: string; external_uri: string; last_synced_at: Date | null }>(
      `SELECT authority, external_uri, last_synced_at FROM entities WHERE id = $1`,
      [entityId],
    )
    expect(row!.authority).toBe('external')
    expect(row!.external_uri).toBe('sdlckg://Service/checkout')
    expect(row!.last_synced_at).not.toBeNull()
  })

  it('BRAIN-11 AC1: an operational kind that does not declare external authority is refused', async () => {
    const { workspaceId, signalId } = await workspaceWithSignal()
    const store = createEntityStore(db.config)
    await expect(
      store.upsertCandidate({
        workspaceId,
        candidate: candidate({ kind: 'environment', externalId: 'sdlckg:Environment:prod', name: 'prod', externalUri: 'sdlckg://Environment/prod' }),
        signalId,
        extractorVersion: 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('BRAIN-11 AC1: an existing kind may also be external authority (a repo mirrored from the graph)', async () => {
    const { workspaceId, signalId } = await workspaceWithSignal()
    const store = createEntityStore(db.config)
    const { entityId } = await store.upsertCandidate({
      workspaceId,
      candidate: candidate({ kind: 'repo', externalId: 'sdlckg:Repository:acme', name: 'acme', authority: 'external', externalUri: 'sdlckg://Repository/acme' }),
      signalId,
      extractorVersion: 1,
    })
    const [row] = await db.admin.query<{ authority: string }>(`SELECT authority FROM entities WHERE id = $1`, [entityId])
    expect(row!.authority).toBe('external')
  })

  it('BRAIN-11 AC1: a brain-authored operational kind is refused with a typed error', async () => {
    const { workspaceId, signalId } = await workspaceWithSignal()
    const store = createEntityStore(db.config)
    await expect(
      store.upsertCandidate({
        workspaceId,
        candidate: candidate({ kind: 'service', externalId: 'x', name: 'c', authority: 'brain', externalUri: 'sdlckg://Service/c' }),
        signalId,
        extractorVersion: 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('BRAIN-11 AC1: an operational kind without a parseable uri is refused', async () => {
    const { workspaceId, signalId } = await workspaceWithSignal()
    const store = createEntityStore(db.config)
    await expect(
      store.upsertCandidate({
        workspaceId,
        candidate: candidate({ kind: 'deployment', externalId: 'x', name: 'd', authority: 'external' }),
        signalId,
        extractorVersion: 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})
