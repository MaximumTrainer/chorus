import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid, type EntityCandidate } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createEntityStore, createExtractionIngestor } from '../../src/index.js'

/**
 * BRAIN-11 AC4 — edges between external entities carry the source's provenance.
 *
 * An external graph supplies `deployed_to` / `runs_on` / `owned_by` /
 * `depends_on` between its entities. Each edge keeps the source event's
 * provenance and confidence 1.0; the extractor stores them as given and never
 * re-scores them.
 */
describe('BRAIN-11 external edge provenance (AC4)', () => {
  let db: IsolatedDatabase

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  async function setup(): Promise<{ workspaceId: string; signalId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM entities WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    const integrationId = (
      await db.admin.query<{ id: string }>(`SELECT id FROM integrations WHERE workspace_id = $1 LIMIT 1`, [workspaceId])
    )[0]!.id
    const signalId = ulid()
    await db.admin.execute(
      `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions)
       VALUES ($1, $2, $3, 'reference', $1, 'node.upserted', 'x', now(), '{"visibility":"public","scopeIds":[]}'::jsonb)`,
      [signalId, workspaceId, integrationId],
    )
    return { workspaceId, signalId }
  }

  const ext = (over: Partial<EntityCandidate> & { externalId: string; name: string; kind: EntityCandidate['kind'] }): EntityCandidate => ({
    aliases: [],
    attributes: {},
    authority: 'external',
    evidence: { signalExternalId: 'sig', source: 'reference' },
    ...over,
  })

  it('BRAIN-11 AC4: a deployed_to edge keeps confidence 1.0 and its provenance signal', async () => {
    const { workspaceId, signalId } = await setup()
    const store = createEntityStore(db.config)
    const deployment = await store.upsertCandidate({
      workspaceId,
      candidate: ext({ kind: 'deployment', externalId: 'sdlckg:Deployment:d1', name: 'd1', externalUri: 'sdlckg://Deployment/d1' }),
      signalId,
      extractorVersion: 1,
    })
    const environment = await store.upsertCandidate({
      workspaceId,
      candidate: ext({ kind: 'environment', externalId: 'sdlckg:Environment:prod', name: 'prod', externalUri: 'sdlckg://Environment/prod' }),
      signalId,
      extractorVersion: 1,
    })

    await store.addEdge({
      workspaceId,
      fromEntityId: deployment.entityId,
      toEntityId: environment.entityId,
      kind: 'deployed_to',
      confidence: 1.0,
      signalId,
      extractorVersion: 1,
    })

    const [edge] = await db.admin.query<{ kind: string; confidence: number; evidence_signal_id: string | null }>(
      `SELECT kind, confidence, evidence_signal_id FROM entity_edges WHERE from_entity_id = $1 AND to_entity_id = $2`,
      [deployment.entityId, environment.entityId],
    )
    expect(edge!.kind).toBe('deployed_to')
    expect(edge!.confidence).toBe(1)
    expect(edge!.evidence_signal_id).toBe(signalId)
  })

  it('BRAIN-11 AC4: the ingestor stores an operational edge at its given confidence, never re-scored', async () => {
    const { workspaceId, signalId } = await setup()
    const store = createEntityStore(db.config)
    const service = await store.upsertCandidate({
      workspaceId,
      candidate: ext({ kind: 'service', externalId: 'sdlckg:Service:checkout', name: 'checkout', externalUri: 'sdlckg://Service/checkout' }),
      signalId,
      extractorVersion: 1,
    })
    const resource = await store.upsertCandidate({
      workspaceId,
      candidate: ext({ kind: 'resource', externalId: 'sdlckg:Resource:db', name: 'db', externalUri: 'sdlckg://Resource/db' }),
      signalId,
      extractorVersion: 1,
    })

    await createExtractionIngestor(store).ingest(workspaceId, {
      signalId,
      extractorVersion: 1,
      entities: [],
      edges: [
        {
          kind: 'runs_on',
          fromExternalId: 'sdlckg:Service:checkout',
          toExternalId: 'sdlckg:Resource:db',
          confidence: 1.0,
          evidence: { signalExternalId: 'sig', source: 'reference' },
        },
      ],
    })

    const [edge] = await db.admin.query<{ confidence: number }>(
      `SELECT confidence FROM entity_edges WHERE from_entity_id = $1 AND to_entity_id = $2 AND kind = 'runs_on'`,
      [service.entityId, resource.entityId],
    )
    expect(edge!.confidence).toBe(1)
  })
})
