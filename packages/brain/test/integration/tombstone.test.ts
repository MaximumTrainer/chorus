import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid, ValidationError, type EntityCandidate } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createEntityStore } from '../../src/index.js'

/**
 * BRAIN-11 AC8 — removal follows the source.
 *
 * When the owning feed emits a tombstone for an external-authority entity, the
 * entity and its edges are removed; an `artefact_links` row pointing at it is
 * marked `dangling` rather than deleted, so a task or document that referenced
 * it keeps its pointer and a reader sees the reference went away rather than it
 * silently vanishing. A duplicate tombstone is a no-op, and a source feed may
 * not tombstone a brain-authored entity.
 */
describe('BRAIN-11 removal follows the source (AC8)', () => {
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
    evidence: { signalExternalId: 'sig', source: 'reference' },
    ...over,
  })

  async function workspace(): Promise<{ workspaceId: string; signalId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM entities WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM artefact_links WHERE workspace_id = $1`, [workspaceId])
    const [integration] = await db.admin.query<{ id: string }>(
      `SELECT id FROM integrations WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    const signalId = ulid()
    await db.admin.execute(
      `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions)
       VALUES ($1, $2, $3, 'reference', $1, 'issue', 'x', now(), '{"visibility":"public","scopeIds":[]}'::jsonb)`,
      [signalId, workspaceId, integration!.id],
    )
    return { workspaceId, signalId }
  }

  async function linkTo(workspaceId: string, entityId: string, fromId: string): Promise<string> {
    const id = ulid()
    await db.admin.execute(
      `INSERT INTO artefact_links (id, workspace_id, from_type, from_id, to_type, to_id, relation)
       VALUES ($1, $2, 'task', $3, 'entity', $4, 'relates_to')`,
      [id, workspaceId, fromId, entityId],
    )
    return id
  }

  async function linkState(linkId: string): Promise<string | undefined> {
    const [row] = await db.admin.query<{ state: string }>(`SELECT state FROM artefact_links WHERE id = $1`, [linkId])
    return row?.state
  }

  it('BRAIN-11 AC8: a tombstone removes the entity and its edges and dangles its links', async () => {
    const { workspaceId, signalId } = await workspace()
    const store = createEntityStore(db.config)

    // An external-authority service the graph owns, and a brain feature related to it.
    const svc = await store.upsertCandidate({
      workspaceId,
      candidate: entity({
        kind: 'service',
        externalId: 'sdlckg:Service:payments',
        name: 'Payments',
        authority: 'external',
        externalUri: 'sdlckg://Service/payments',
      }),
      signalId,
      extractorVersion: 1,
    })
    const feature = await store.upsertCandidate({
      workspaceId,
      candidate: entity({ externalId: 'e:checkout', name: 'Checkout' }),
      signalId,
      extractorVersion: 1,
    })
    await store.addEdge({
      workspaceId,
      fromEntityId: feature.entityId,
      toEntityId: svc.entityId,
      kind: 'depends_on',
      confidence: 1,
      extractorVersion: 1,
    })
    // A task links to the service.
    const link = await linkTo(workspaceId, svc.entityId, ulid())

    // When the source emits a tombstone for it.
    const outcome = await store.tombstoneExternal({ workspaceId, externalId: 'sdlckg:Service:payments' })
    expect(outcome).toMatchObject({ removed: true, danglingLinks: 1 })

    // The entity is gone, and its edge went with it.
    expect(await store.findByExternalId(workspaceId, 'sdlckg:Service:payments')).toBeNull()
    expect(await store.edges(workspaceId)).toHaveLength(0)
    // The brain entity it pointed at is untouched.
    expect(await store.findByExternalId(workspaceId, 'e:checkout')).toBe(feature.entityId)
    // The link is kept but marked dangling, not deleted.
    expect(await linkState(link)).toBe('dangling')
  })

  it('BRAIN-11 AC8: a duplicate tombstone is a no-op', async () => {
    const { workspaceId, signalId } = await workspace()
    const store = createEntityStore(db.config)
    await store.upsertCandidate({
      workspaceId,
      candidate: entity({
        kind: 'environment',
        externalId: 'sdlckg:Environment:prod',
        name: 'prod',
        authority: 'external',
        externalUri: 'sdlckg://Environment/prod',
      }),
      signalId,
      extractorVersion: 1,
    })
    const first = await store.tombstoneExternal({ workspaceId, externalId: 'sdlckg:Environment:prod' })
    expect(first.removed).toBe(true)
    const second = await store.tombstoneExternal({ workspaceId, externalId: 'sdlckg:Environment:prod' })
    expect(second).toMatchObject({ removed: false, danglingLinks: 0 })
  })

  it('BRAIN-11 AC8: a source feed may not tombstone a brain-authored entity', async () => {
    const { workspaceId, signalId } = await workspace()
    const store = createEntityStore(db.config)
    await store.upsertCandidate({
      workspaceId,
      candidate: entity({ externalId: 'e:brainy', name: 'Brainy' }),
      signalId,
      extractorVersion: 1,
    })
    await expect(store.tombstoneExternal({ workspaceId, externalId: 'e:brainy' })).rejects.toBeInstanceOf(
      ValidationError,
    )
    // And it is still there.
    expect(await store.findByExternalId(workspaceId, 'e:brainy')).not.toBeNull()
  })
})
