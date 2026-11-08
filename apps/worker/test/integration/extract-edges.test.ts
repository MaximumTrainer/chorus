import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createEntityStore } from '@chorus/brain'
import { createJiraConnector } from '@chorus/connectors'
import { createDeterministicExtractor } from '../../src/extract.js'

/**
 * INT-8 AC7 — Jira issue links become edges between Ticket entities.
 *
 * The deterministic pass reads the links Jira states on an issue and lands the
 * `duplicates` and `blocks` edges between the issues' entities — in a second
 * pass, so an edge is written only once both ends have been ingested, and an
 * edge to an issue not yet seen is skipped rather than invented.
 */
describe('INT-8 issue links become edges', () => {
  let db: IsolatedDatabase

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  async function freshWorkspace(): Promise<{ workspaceId: string; integrationId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM entity_edges WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM entities WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    const integrationId = ulid()
    await db.admin.execute(`INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'jira')`, [
      integrationId,
      workspaceId,
    ])
    return { workspaceId, integrationId }
  }

  async function ingestIssue(
    workspaceId: string,
    integrationId: string,
    key: string,
    raw: Record<string, unknown>,
  ): Promise<void> {
    await db.admin.execute(
      `INSERT INTO signals
         (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions, raw)
       VALUES ($1, $2, $3, 'jira', $4, 'issue', $5, now(),
               '{"visibility":"public","scopeIds":[]}'::jsonb, $6::jsonb)`,
      [ulid(), workspaceId, integrationId, `jira:issue:${key}`, key, JSON.stringify(raw)],
    )
  }

  const issue = (key: string, issuelinks: unknown[] = []): Record<string, unknown> => ({
    id: `id-${key}`,
    key,
    fields: {
      summary: `Issue ${key}`,
      issuetype: { name: 'Bug' },
      status: { name: 'To Do' },
      project: { key: 'ACME', id: 'proj-1' },
      issuelinks,
    },
  })

  const extractor = () =>
    createDeterministicExtractor({
      config: db.config,
      connectorsByKind: { jira: () => createJiraConnector() },
      entities: createEntityStore(db.config),
      extractorVersion: 1,
    })

  it('INT-8 AC7: a blocks link and a duplicates link become edges between the Ticket entities', async () => {
    const { workspaceId, integrationId } = await freshWorkspace()
    const store = createEntityStore(db.config)

    // ACME-7 blocks ACME-8 (outward), and is duplicated by ACME-9 (inward).
    await ingestIssue(workspaceId, integrationId, 'ACME-7', issue('ACME-7', [
      { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'ACME-8' } },
      { type: { name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' }, inwardIssue: { key: 'ACME-9' } },
    ]))
    await ingestIssue(workspaceId, integrationId, 'ACME-8', issue('ACME-8'))
    await ingestIssue(workspaceId, integrationId, 'ACME-9', issue('ACME-9'))

    const outcome = await extractor().extract(workspaceId)
    expect(outcome.edges).toBe(2)

    const ids = {
      seven: await store.findByExternalId(workspaceId, 'jira:issue:ACME-7'),
      eight: await store.findByExternalId(workspaceId, 'jira:issue:ACME-8'),
      nine: await store.findByExternalId(workspaceId, 'jira:issue:ACME-9'),
    }
    const edges = await store.edges(workspaceId)
    expect(edges).toContainEqual({ fromEntityId: ids.seven, toEntityId: ids.eight, kind: 'blocks' })
    expect(edges).toContainEqual({ fromEntityId: ids.nine, toEntityId: ids.seven, kind: 'duplicates' })
  })

  it('INT-8 AC7: a link to an issue that has not been ingested is skipped, not invented', async () => {
    const { workspaceId, integrationId } = await freshWorkspace()
    const store = createEntityStore(db.config)

    await ingestIssue(workspaceId, integrationId, 'ACME-7', issue('ACME-7', [
      { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'ACME-404' } },
    ]))

    const outcome = await extractor().extract(workspaceId)
    expect(outcome.edges).toBe(0)
    expect(await store.edges(workspaceId)).toHaveLength(0)
  })

  it('INT-8 AC7: re-extracting the same links makes no duplicate edges', async () => {
    const { workspaceId, integrationId } = await freshWorkspace()
    const store = createEntityStore(db.config)

    await ingestIssue(workspaceId, integrationId, 'ACME-7', issue('ACME-7', [
      { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'ACME-8' } },
    ]))
    await ingestIssue(workspaceId, integrationId, 'ACME-8', issue('ACME-8'))

    await extractor().extract(workspaceId)
    await extractor().extract(workspaceId)

    expect(await store.edges(workspaceId)).toHaveLength(1)
  })
})
