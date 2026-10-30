import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  createKeyring,
  parseMasterKey,
  ulid,
  type ExternalRef,
  type ToolContext,
} from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createCredentialStore, createReferenceConnector } from '@chorus/connectors'
import { createConnectorSinkDispatcher } from '../../src/sink-dispatch.js'

/**
 * INT-4 — the worker's connector sink dispatcher, against a real credential store.
 *
 * This is the concrete half of the sink seam (option 2): a sink tool's write,
 * resolved to the workspace's connected connector, its credentials decrypted,
 * and performed through the connector's own sink action. Proven here against
 * the reference connector — which ships a sink — so the resolution and write
 * path are exercised without a live tracker. A workspace with nothing connected
 * fails by name rather than writing nowhere.
 */
describe('INT-4 worker sink dispatcher', () => {
  let db: IsolatedDatabase
  const master = parseMasterKey('k1', randomBytes(32).toString('base64'))

  const ctx = (workspaceId: string): ToolContext => ({
    workspaceId,
    teamId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
    runId: 'run-1',
    actor: { userId: 'user-1', role: 'owner' },
    now: () => new Date('2026-09-03T12:00:00.000Z'),
  })

  const dispatcher = () =>
    createConnectorSinkDispatcher({
      credentials: createCredentialStore(db.config, createKeyring([master]), master),
      connectors: [{ kind: 'reference', create: () => createReferenceConnector() }],
    })

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  async function workspaceWithReference(): Promise<string> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM integrations WHERE workspace_id = $1`, [workspaceId])
    // The seed wraps a data key under its own master; clear it so `connect`
    // mints a fresh one under this test's key.
    await db.admin.execute(`DELETE FROM workspace_data_keys WHERE workspace_id = $1`, [workspaceId])
    await createCredentialStore(db.config, createKeyring([master]), master).connect({
      workspaceId,
      kind: 'reference',
      credentials: { token: 'ref-token' },
      config: {},
    })
    return workspaceId
  }

  it('INT-4: resolves the connected connector and performs the write', async () => {
    const workspaceId = await workspaceWithReference()

    const ref = await dispatcher().dispatch(
      { action: 'create_item', input: { text: 'ship it' }, idempotencyKey: 'run-1:create_item:abc' },
      ctx(workspaceId),
    )

    expect(ref.externalId, 'the write returns the object the connector made').toBeTruthy()
    expect((ref as ExternalRef).url).toContain('reference.test')
  })

  it('INT-4: a workspace with no connected tracker fails by name, not silently', async () => {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM integrations WHERE workspace_id = $1`, [workspaceId])

    await expect(
      dispatcher().dispatch(
        { action: 'create_item', input: { text: 'x' }, idempotencyKey: 'run-1:create_item:x' },
        ctx(workspaceId),
      ),
    ).rejects.toThrow(/no connected tracker/i)
  })

  it('INT-4: an action the connector does not offer fails by name', async () => {
    const workspaceId = await workspaceWithReference()

    await expect(
      dispatcher().dispatch(
        { action: 'transition', input: {}, idempotencyKey: 'run-1:transition:x' },
        ctx(workspaceId),
      ),
    ).rejects.toThrow(/no "transition" sink action/i)
  })
})
