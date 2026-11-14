import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createKeyring, parseMasterKey, ulid } from '@chorus/core'
import { createQueue, redisConfigFromEnv, type Queue } from '@chorus/queue'
import { createIndexer } from '@chorus/indexer'
import { createEntityStore, createRetriever, createScopeMemberships } from '@chorus/brain'
import {
  createConfluenceConnector,
  createCredentialStore,
  createReferenceConnector,
  type CredentialStore,
  type ReferenceItem,
} from '@chorus/connectors'
import { cassettePlayer } from '@chorus/connectors/testing'
import { createFakeModelProvider } from '@chorus/testing'
import { createWorker, type RunningWorker } from '../../src/worker.js'
import { createSyncScheduler } from '../../src/sync-scheduler.js'
import { SYNC_INTEGRATION_QUEUE } from '../../src/consumers/sync-integration.js'

/**
 * BRAIN-1 — signals are ingested from connected sources on a schedule.
 *
 * Until now the sync runner, the extractor and the membership sync existed but
 * nothing ran them. A scheduler tick enqueues a sync for every connected source
 * integration, at most once per interval; the worker runs it, then extracts
 * entities from what arrived. A backfill longer than one run's page budget
 * continues from its persisted cursor in a follow-up job rather than waiting a
 * whole interval or starting again (AC5).
 */
describe('BRAIN-1 scheduled ingestion', () => {
  const master = parseMasterKey('k1', randomBytes(32).toString('base64'))
  const INTERVAL = 15 * 60 * 1000
  const T0 = new Date('2026-11-14T12:00:00.000Z')

  let db: IsolatedDatabase
  let queue: Queue
  let store: CredentialStore
  let worker: RunningWorker
  const reference = createReferenceConnector()

  const items = (count: number): ReferenceItem[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `item-${String(i + 1).padStart(3, '0')}`,
      text: i === 2 ? 'a restricted thing about payroll' : `public note ${i + 1} about the roadmap`,
      at: new Date(Date.UTC(2026, 10, 1, i)).toISOString(),
      author: 'ada',
      ...(i === 2 ? { restrictedTo: 'room-1' } : {}),
    }))

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    queue = createQueue({ ...redisConfigFromEnv(), prefix: `brain1-${ulid()}` })
    store = createCredentialStore(db.config, createKeyring([master]), master)
    worker = await createWorker({
      queue,
      dbConfig: db.config,
      indexer: await createIndexer(db.config, {
        embed: async (texts) => texts.map(() => new Array<number>(1536).fill(0.1)),
        embeddingModel: 'fake-embed-v1',
      }),
      access: { cloneUrlFor: async () => ({ remote: 'unused' }) },
      sync: {
        credentials: store,
        connectors: { reference: () => reference },
        entities: createEntityStore(db.config),
        now: () => T0,
        // One page per run, so a five-item backfill takes several jobs (AC5).
        maxPagesPerRun: 1,
      },
    })
  }, 180_000)

  afterAll(async () => {
    await worker?.stop()
    await db?.drop()
  })

  async function connected(): Promise<{ workspaceId: string; integrationId: string; userId: string; teamId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    for (const table of ['signals', 'integrations', 'workspace_data_keys', 'entities']) {
      await db.admin.execute(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId])
    }
    const integration = await store.connect({ workspaceId, kind: 'reference', credentials: { token: 'ref' } })
    const [owner] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    const [team] = await db.admin.query<{ id: string }>(`SELECT id FROM teams WHERE workspace_id = $1 LIMIT 1`, [
      workspaceId,
    ])
    return { workspaceId, integrationId: integration.id, userId: owner!.user_id, teamId: team!.id }
  }

  const scheduler = () =>
    createSyncScheduler({ dbConfig: db.config, queue, kinds: ['reference'], intervalMs: INTERVAL })

  const signalsIn = (workspaceId: string) =>
    db.admin.query<{
      external_id: string
      source: string
      occurred_at: Date
      author: string | null
      permissions: { visibility: string; scopeIds: string[] }
    }>(
      `SELECT external_id, source, occurred_at, author, permissions
         FROM signals WHERE workspace_id = $1 ORDER BY external_id`,
      [workspaceId],
    )

  it('BRAIN-1: content from a connected source becomes searchable with complete provenance', async () => {
    reference.script({ items: items(5), pageSize: 2 })
    const w = await connected()

    const { enqueued } = await scheduler().tick(T0)
    expect(enqueued).toBeGreaterThanOrEqual(1)
    await queue.drain(SYNC_INTEGRATION_QUEUE)

    // The whole backfill landed, across follow-up jobs, with complete provenance (AC1, AC5).
    const signals = await signalsIn(w.workspaceId)
    expect(signals.map((s) => s.external_id)).toEqual(items(5).map((i) => i.id))
    for (const s of signals) {
      expect(s.source).toBe('reference')
      expect(s.occurred_at).toBeInstanceOf(Date)
      expect(s.permissions.visibility).toMatch(/public|restricted/)
    }
    // The restriction was captured where retrieval can enforce it (AC4).
    expect(signals.find((s) => s.external_id === 'item-003')!.permissions).toMatchObject({ visibility: 'restricted' })

    // Entities were extracted from what arrived.
    expect((await createEntityStore(db.config).list(w.workspaceId)).length).toBeGreaterThan(0)

    // And it is searchable — the public content, not the restricted item.
    const retriever = createRetriever(db.config, {
      models: createFakeModelProvider(),
      embeddingModel: { provider: 'fake', model: 'fake-embed' },
    })
    const found = await retriever.retrieve({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      userId: w.userId,
      query: 'roadmap payroll',
      kinds: ['signal'],
      k: 10,
    })
    expect(found.fragments.map((f) => f.text)).not.toContain('a restricted thing about payroll')
    expect(found.fragments.length).toBe(4)
  })

  it('BRAIN-1 AC5: a backfill continues from its cursor, pulling each page exactly once', async () => {
    reference.script({ items: items(5), pageSize: 2 })
    const w = await connected()
    const pullsBefore = reference.cursorsSeen.length

    await scheduler().tick(T0)
    await queue.drain(SYNC_INTEGRATION_QUEUE)

    const pulls = reference.cursorsSeen.slice(pullsBefore)
    // Three pages of two, each pulled once, in order — never re-pulled, never skipped.
    expect(pulls).toHaveLength(3)
    expect(new Set(pulls.map(String)).size).toBe(3)
    expect((await signalsIn(w.workspaceId)).length).toBe(5)
  })

  it('BRAIN-1 AC2: a second tick in the same interval runs no second sync; the next interval adds no duplicates', async () => {
    reference.script({ items: items(2), pageSize: 2 })
    const w = await connected()

    await scheduler().tick(T0)
    await queue.drain(SYNC_INTEGRATION_QUEUE)
    const pullsAfterFirst = reference.cursorsSeen.length

    // Ticks are frequent; the interval is what bounds how often a source is asked.
    await scheduler().tick(new Date(T0.getTime() + 60_000))
    await queue.drain(SYNC_INTEGRATION_QUEUE)
    expect(reference.cursorsSeen.length, 'no second sync within the interval').toBe(pullsAfterFirst)

    await scheduler().tick(new Date(T0.getTime() + INTERVAL))
    await queue.drain(SYNC_INTEGRATION_QUEUE)
    expect((await signalsIn(w.workspaceId)).length).toBe(2)
  })

  it('BRAIN-1: a disconnected integration is not scheduled', async () => {
    reference.script({ items: items(2), pageSize: 2 })
    const w = await connected()
    await db.admin.execute(`UPDATE integrations SET status = 'disconnected' WHERE id = $1`, [w.integrationId])

    await scheduler().tick(T0)
    await queue.drain(SYNC_INTEGRATION_QUEUE)
    expect(await signalsIn(w.workspaceId)).toEqual([])
  })
})

describe('BRAIN-1 scheduled ingestion of a Confluence integration', () => {
  const master = parseMasterKey('k1', randomBytes(32).toString('base64'))
  const T0 = new Date('2026-11-14T12:00:00.000Z')
  let db: IsolatedDatabase
  let queue: Queue
  let store: CredentialStore
  let worker: RunningWorker

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    queue = createQueue({ ...redisConfigFromEnv(), prefix: `brain1-conf-${ulid()}` })
    store = createCredentialStore(db.config, createKeyring([master]), master)
    worker = await createWorker({
      queue,
      dbConfig: db.config,
      indexer: await createIndexer(db.config, {
        embed: async (texts) => texts.map(() => new Array<number>(1536).fill(0.1)),
        embeddingModel: 'fake-embed-v1',
      }),
      access: { cloneUrlFor: async () => ({ remote: 'unused' }) },
      sync: {
        credentials: store,
        connectors: {
          confluence: () =>
            createConfluenceConnector({
              apiUrl: 'https://conf.test/api',
              fetch: cassettePlayer('confluence/scheduled-sync.json'),
            }),
        },
        entities: createEntityStore(db.config),
        memberships: createScopeMemberships(db.config),
        now: () => T0,
      },
    })
  }, 180_000)

  afterAll(async () => {
    await worker?.stop()
    await db?.drop()
  })

  it('BRAIN-1 / NFR-4: a scheduled Confluence sync ingests pages and then grants them to their readers', async () => {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    for (const table of ['signals', 'integrations', 'workspace_data_keys', 'source_scope_memberships', 'linked_accounts']) {
      await db.admin.execute(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId])
    }
    const integration = await store.connect({
      workspaceId,
      kind: 'confluence',
      credentials: { accessToken: 'confluence_access' },
      config: { siteUrl: 'https://acme.atlassian.net', privateByDefault: true },
    })
    const [owner] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    const [team] = await db.admin.query<{ id: string }>(`SELECT id FROM teams WHERE workspace_id = $1 LIMIT 1`, [
      workspaceId,
    ])
    // The owner linked her own Atlassian account (ADR-0024); she is a reader of space 98.
    await db.admin.execute(
      `INSERT INTO linked_accounts (id, workspace_id, user_id, provider, account_id) VALUES ($1, $2, $3, 'atlassian', 'acc-ada')`,
      [ulid(), workspaceId, owner!.user_id],
    )
    // Someone else, not linked.
    const otherId = ulid()
    await db.admin.execute(`INSERT INTO users (id, email, name, email_verified) VALUES ($1, $2, 'Other', true)`, [
      otherId,
      `other-${otherId}@example.test`,
    ])
    await db.admin.execute(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES ($1, $2, $3, 'member')`,
      [ulid(), workspaceId, otherId],
    )

    await createSyncScheduler({ dbConfig: db.config, queue, kinds: ['confluence'], intervalMs: 15 * 60 * 1000 }).tick(T0)
    await queue.drain(SYNC_INTEGRATION_QUEUE)

    const [signal] = await db.admin.query<{ permissions: { scopeIds: string[] } }>(
      `SELECT permissions FROM signals WHERE workspace_id = $1 AND integration_id = $2`,
      [workspaceId, integration.id],
    )
    expect(signal!.permissions.scopeIds).toEqual(['confluence:space:98'])
    expect((await createScopeMemberships(db.config).scopesFor(workspaceId, owner!.user_id)).sort()).toEqual([
      'confluence:space:98',
      'confluence:user:acc-ada',
    ])

    const retriever = createRetriever(db.config, {
      models: createFakeModelProvider(),
      embeddingModel: { provider: 'fake', model: 'fake-embed' },
    })
    const count = async (userId: string) => {
      const bundle = await retriever.retrieve({
        workspaceId,
        teamId: team!.id,
        userId,
        query: 'deploy timeout',
        kinds: ['signal'],
      })
      return bundle.considered
    }
    expect(await count(owner!.user_id)).toBeGreaterThan(0)
    expect(await count(otherId)).toBe(0)
  })
})
