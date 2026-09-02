import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { RateLimitedError, createKeyring, parseMasterKey, ulid } from '@chorus/core'
import { createCredentialStore, type CredentialStore } from '../../src/credentials.js'
import { createSyncRunner, type SyncRunner } from '../../src/sync.js'
import { createReferenceConnector, type ReferenceItem } from '../../src/reference/index.js'

/**
 * INT-1 AC2, AC4, AC5 — the sync runner against a real database.
 *
 * The guarantee under test is that **work is never lost and never repeated**.
 * Both halves matter and they pull in opposite directions: a runner that
 * commits its cursor before its signals loses a page on a crash, and one that
 * commits signals without a cursor re-ingests the same page forever. Only a
 * real transaction can show which of the two a given implementation is, which
 * is why this is an integration test and not a unit one.
 */
describe('INT-1 sync runner', () => {
  let db: IsolatedDatabase
  let store: CredentialStore
  let runner: SyncRunner
  const master = parseMasterKey('k1', randomBytes(32).toString('base64'))
  const frozen = new Date('2026-09-02T12:00:00.000Z')

  const items = (count: number): ReferenceItem[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `item-${String(index + 1).padStart(3, '0')}`,
      text: `thing ${index + 1}`,
      at: new Date(Date.UTC(2026, 8, 1, index)).toISOString(),
      author: 'ada',
    }))

  /**
   * A workspace and a connected integration of this test's own (CLAUDE.md §5).
   *
   * `seedWorkspace` plants one row in every tenant table so the tenancy suite
   * has something to try to read across the boundary. Those placeholders are
   * cleared here: this suite counts signals, and a seeded one would make every
   * count off by one for a reason that has nothing to do with syncing.
   */
  async function connected(): Promise<{ workspaceId: string; integrationId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM integrations WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM workspace_data_keys WHERE workspace_id = $1`, [workspaceId])
    const integration = await store.connect({
      workspaceId,
      kind: 'reference',
      credentials: { token: 'reference-token' },
    })
    return { workspaceId, integrationId: integration.id }
  }

  const signalsIn = (workspaceId: string) =>
    db.admin.query<{ external_id: string; kind: string }>(
      `SELECT external_id, kind FROM signals WHERE workspace_id = $1 ORDER BY external_id`,
      [workspaceId],
    )

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    store = createCredentialStore(db.config, createKeyring([master]), master)
    runner = createSyncRunner(db.config, store, { now: () => frozen })
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('INT-1 AC2: a full sync ingests every signal exactly once and ends caught up', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector({ items: items(10), pageSize: 3 })

    const outcome = await runner.sync(workspaceId, integrationId, connector)

    expect(outcome.state).toBe('caught_up')
    expect(outcome.ingested).toBe(10)
    const rows = await signalsIn(workspaceId)
    expect(rows).toHaveLength(10)
    expect(new Set(rows.map((r) => r.external_id)).size).toBe(10)
  })

  it('INT-1 AC2: an interrupted sync resumes from the persisted cursor, with no gap and no re-ingestion', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector({ items: items(10), pageSize: 3 })

    // Given a sync stopped after two pages, as a restart would stop it
    const first = await runner.sync(workspaceId, integrationId, connector, { maxPages: 2 })
    expect(first.state).toBe('interrupted')
    expect(first.ingested).toBe(6)

    // The cursor is in the database, not in the runner's memory — a restart
    // takes the process with it.
    const [row] = await db.admin.query<{ sync_cursor: string | null }>(
      `SELECT sync_cursor FROM integrations WHERE id = $1`,
      [integrationId],
    )
    expect(row!.sync_cursor).toBe('item-006')

    // When a fresh runner resumes
    const resumed = createSyncRunner(db.config, store, { now: () => frozen })
    const second = await resumed.sync(workspaceId, integrationId, connector)

    // Then it continues where it left off, and re-ingests nothing
    expect(second.state).toBe('caught_up')
    expect(second.ingested).toBe(4)
    expect(second.duplicates).toBe(0)
    expect(connector.cursorsSeen.at(2), 'it must resume from the persisted cursor').toBe('item-006')

    const rows = await signalsIn(workspaceId)
    expect(rows.map((r) => r.external_id)).toEqual(items(10).map((item) => item.id))
  })

  it('INT-1 AC2: a page and its cursor are committed together, so a failure loses neither', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector({ items: items(9), pageSize: 3 })

    // Given a connector that fails on its third page
    let pages = 0
    const original = connector.pull!.bind(connector)
    connector.pull = async (cursor, ctx) => {
      pages += 1
      if (pages === 3) throw new Error('the source hung up')
      return original(cursor, ctx)
    }

    const outcome = await runner.sync(workspaceId, integrationId, connector)

    // Then the two pages that succeeded are durable, and the cursor names the
    // last of them exactly — not one page further, and not one page short.
    expect(outcome.state).toBe('failed')
    expect(await signalsIn(workspaceId)).toHaveLength(6)
    const [row] = await db.admin.query<{ sync_cursor: string }>(
      `SELECT sync_cursor FROM integrations WHERE id = $1`,
      [integrationId],
    )
    expect(row!.sync_cursor).toBe('item-006')
  })

  it('INT-1 AC2: re-running a completed sync ingests nothing new', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector({ items: items(6), pageSize: 2 })

    await runner.sync(workspaceId, integrationId, connector)
    const again = await runner.sync(workspaceId, integrationId, connector)

    expect(again.ingested).toBe(0)
    expect(await signalsIn(workspaceId)).toHaveLength(6)
  })

  it('INT-1 AC2: a signal the source repeats is deduplicated rather than duplicated', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector({ items: items(4), pageSize: 4 })

    await runner.sync(workspaceId, integrationId, connector)

    // The source re-serves the same items from the start, as a reset cursor or
    // an overlapping page would.
    await db.admin.execute(`UPDATE integrations SET sync_cursor = NULL WHERE id = $1`, [
      integrationId,
    ])
    const outcome = await runner.sync(workspaceId, integrationId, connector)

    expect(outcome.ingested).toBe(0)
    expect(outcome.duplicates).toBe(4)
    expect(await signalsIn(workspaceId)).toHaveLength(4)
  })

  it('INT-1 AC4: a rate limit stops the sync, keeps the work done, and asks to be retried', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector({ items: items(9), pageSize: 3 })

    let pages = 0
    const original = connector.pull!.bind(connector)
    connector.pull = async (cursor, ctx) => {
      pages += 1
      if (pages === 3) throw new RateLimitedError('Slow down', { retryAfterMs: 30_000 })
      return original(cursor, ctx)
    }

    const outcome = await runner.sync(workspaceId, integrationId, connector)

    // Backing off must not throw away the two pages already ingested — a
    // rate limit is the moment a naive runner restarts from the beginning and
    // is rate-limited again forever.
    expect(outcome.state).toBe('rate_limited')
    expect(outcome.retryAfterMs).toBe(30_000)
    expect(await signalsIn(workspaceId)).toHaveLength(6)

    const [row] = await db.admin.query<{ sync_cursor: string }>(
      `SELECT sync_cursor FROM integrations WHERE id = $1`,
      [integrationId],
    )
    expect(row!.sync_cursor).toBe('item-006')
  })

  it('INT-1 AC4/AC5: the rate limit is recorded in health, with what to do about it', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector({ items: items(3), pageSize: 3 })
    connector.pull = async () => {
      throw new RateLimitedError('Slow down', { retryAfterMs: 60_000 })
    }

    await runner.sync(workspaceId, integrationId, connector)

    const [row] = await db.admin.query<{ status: string; health: Record<string, unknown> }>(
      `SELECT status, health FROM integrations WHERE id = $1`,
      [integrationId],
    )
    expect(row!.status).toBe('degraded')
    expect(row!.health).toMatchObject({ state: 'degraded' })
    expect(String(row!.health.problem)).toMatch(/rate limit/i)
    expect(String(row!.health.remedy)).toBeTruthy()
    expect(row!.health.retryAfterMs).toBe(60_000)
  })

  it('INT-1 AC5: a successful sync records when it last succeeded', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector({ items: items(3), pageSize: 3 })

    await runner.sync(workspaceId, integrationId, connector)

    const [row] = await db.admin.query<{ status: string; health: Record<string, unknown> }>(
      `SELECT status, health FROM integrations WHERE id = $1`,
      [integrationId],
    )
    expect(row!.status).toBe('connected')
    expect(row!.health).toMatchObject({ state: 'ok' })
    expect(row!.health.lastSuccessfulSyncAt).toBe(frozen.toISOString())
    expect(row!.health.lastError ?? null).toBeNull()
  })

  it('INT-1 AC5: a failure records the error but keeps the last success, which is what makes it readable', async () => {
    const { workspaceId, integrationId } = await connected()
    const good = createReferenceConnector({ items: items(3), pageSize: 3 })
    await runner.sync(workspaceId, integrationId, good)

    const bad = createReferenceConnector({ items: items(3), pageSize: 3 })
    bad.pull = async () => {
      throw new Error('the source returned 500')
    }
    await runner.sync(workspaceId, integrationId, bad)

    const [row] = await db.admin.query<{ status: string; health: Record<string, unknown> }>(
      `SELECT status, health FROM integrations WHERE id = $1`,
      [integrationId],
    )
    // "Failing since 09:00, last worked at 08:55" is the sentence an admin
    // needs. Dropping the last success on failure deletes half of it.
    expect(row!.status).toBe('failed')
    expect(row!.health.lastSuccessfulSyncAt).toBe(frozen.toISOString())
    expect(String(row!.health.lastError)).toMatch(/500/)
  })

  it('INT-1 AC5: an error message recorded in health never carries the credential', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector({ items: items(3), pageSize: 3 })
    connector.pull = async (_cursor, ctx) => {
      // A connector that interpolates its context into an error is exactly how
      // a credential reaches a health page an admin can read.
      throw new Error(`request failed with token ${ctx.credentials.token}`)
    }

    await runner.sync(workspaceId, integrationId, connector)

    const [row] = await db.admin.query<{ health: Record<string, unknown> }>(
      `SELECT health FROM integrations WHERE id = $1`,
      [integrationId],
    )
    expect(JSON.stringify(row!.health)).not.toContain('reference-token')
  })

  it('INT-1: signals are stored with their provenance and permission scope intact', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector()

    await runner.sync(workspaceId, integrationId, connector)

    const [row] = await db.admin.query<{
      source: string
      kind: string
      text: string
      author: string | null
      occurred_at: Date
      url: string | null
      permissions: { visibility: string; scopeIds: string[] }
      integration_id: string
    }>(
      `SELECT source, kind, text, author, occurred_at, url, permissions, integration_id
         FROM signals WHERE workspace_id = $1 AND external_id = 'item-3'`,
      [workspaceId],
    )
    expect(row).toMatchObject({
      source: 'reference',
      kind: 'message',
      integration_id: integrationId,
      permissions: { visibility: 'restricted', scopeIds: ['room-1'] },
    })
    expect(row!.occurred_at.toISOString()).toBe('2026-09-01T11:00:00.000Z')
  })

  it("INT-1: one workspace's signals are invisible to another", async () => {
    const mine = await connected()
    const theirs = await connected()
    await runner.sync(mine.workspaceId, mine.integrationId, createReferenceConnector())

    expect(await signalsIn(theirs.workspaceId)).toHaveLength(0)
  })

  it('INT-1: a connector emitting an invalid signal fails the page rather than storing it', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createReferenceConnector({ items: items(3), pageSize: 3 })
    connector.pull = async () => ({
      // A restricted signal with no scope would be either invisible to everyone
      // or visible to everyone at retrieval. It must not reach the table.
      signals: [
        {
          source: 'reference',
          externalId: 'bad-1',
          kind: 'message',
          text: 'x',
          structured: {},
          author: null,
          occurredAt: new Date(),
          url: null,
          permissions: { visibility: 'restricted', scopeIds: [] },
          raw: {},
        },
      ] as never,
      nextCursor: null,
    })

    const outcome = await runner.sync(workspaceId, integrationId, connector)

    expect(outcome.state).toBe('failed')
    expect(await signalsIn(workspaceId)).toHaveLength(0)
  })
})
