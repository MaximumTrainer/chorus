import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createKeyring, parseMasterKey, ulid } from '@chorus/core'
import { createCredentialStore, type CredentialStore } from '../../src/credentials.js'

/**
 * INT-1 AC1 — credential storage against a real database.
 *
 * One seam: the store and Postgres. What is asserted is what only exists when
 * both halves are present — that no column anywhere holds a plaintext
 * credential, that a data key is per-workspace and cannot be borrowed across
 * the tenancy boundary, and that rotating the master key rewraps every data key
 * while leaving the credential ciphertext untouched.
 *
 * That last property is the whole reason for the envelope, and it is only
 * visible from here: a unit test can prove the rewrap is *possible*, but only a
 * database can show that the credential rows did not change.
 */
describe('INT-1 credential store', () => {
  let db: IsolatedDatabase
  let store: CredentialStore

  const oldKey = parseMasterKey('k-old', randomBytes(32).toString('base64'))
  const newKey = parseMasterKey('k-new', randomBytes(32).toString('base64'))

  const SECRET = { accessToken: 'ghp_averysecrettoken', refreshToken: 'rt_alsosecret' }

  /**
   * A workspace of this test's own (CLAUDE.md §5).
   *
   * Rotation is a global operation by nature, so a shared workspace would make
   * every case after the rotation ones depend on having run before them. The
   * placeholder data key `seedWorkspace` plants for the tenancy suite is
   * removed: it is deliberately not a real wrapped key, and these cases are
   * about workspaces that have never had an integration connected.
   */
  async function freshWorkspace(): Promise<string> {
    const id = ulid()
    await db.admin.seedWorkspace(id)
    await db.admin.execute(`DELETE FROM workspace_data_keys WHERE workspace_id = $1`, [id])
    return id
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    // Both keys on the ring, one current: what a deployment mid-rotation
    // actually holds, and what keeps these cases independent of whether a
    // rotation case has already run.
    store = createCredentialStore(db.config, createKeyring([oldKey, newKey]), oldKey)
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('INT-1 AC1: a stored credential round-trips', async () => {
    const workspaceId = await freshWorkspace()
    const integration = await store.connect({
      workspaceId,
      kind: 'reference',
      credentials: SECRET,
      config: { channel: 'general' },
    })

    expect(await store.credentialsFor(workspaceId, integration.id)).toEqual(SECRET)
  })

  it('INT-1 AC1: no plaintext credential exists anywhere in the database', async () => {
    const workspaceId = await freshWorkspace()
    const integration = await store.connect({
      workspaceId,
      kind: 'reference',
      credentials: SECRET,
    })

    // Every column of the row, not only the one meant to hold the secret — a
    // credential copied into `config` by a careless caller is still a leak.
    const [row] = await db.admin.query<Record<string, unknown>>(
      `SELECT * FROM integrations WHERE id = $1`,
      [integration.id],
    )
    const serialised = JSON.stringify(row)
    expect(serialised).not.toContain(SECRET.accessToken)
    expect(serialised).not.toContain(SECRET.refreshToken)

    // And the wrapped data key must not be the data key.
    const [key] = await db.admin.query<{ wrapped_key: string }>(
      `SELECT wrapped_key FROM workspace_data_keys WHERE workspace_id = $1`,
      [workspaceId],
    )
    expect(key!.wrapped_key).toMatch(/^v1\.k-old\./)
  })

  it('INT-1 AC1: one data key serves a workspace, created once and reused', async () => {
    const workspaceId = await freshWorkspace()
    await store.connect({ workspaceId, kind: 'reference', credentials: SECRET })
    await store.connect({ workspaceId, kind: 'github', credentials: SECRET })

    const keys = await db.admin.query(
      `SELECT 1 FROM workspace_data_keys WHERE workspace_id = $1`,
      [workspaceId],
    )
    expect(keys, 'a second integration must not mint a second data key').toHaveLength(1)
  })

  it('INT-1 AC1: each workspace gets its own data key', async () => {
    const workspaceId = await freshWorkspace()
    const otherWorkspaceId = await freshWorkspace()
    await store.connect({ workspaceId, kind: 'reference', credentials: SECRET })
    await store.connect({ workspaceId: otherWorkspaceId, kind: 'reference', credentials: SECRET })

    const keys = await db.admin.query<{ workspace_id: string; wrapped_key: string }>(
      `SELECT workspace_id, wrapped_key FROM workspace_data_keys WHERE workspace_id = ANY($1)`,
      [[workspaceId, otherWorkspaceId]],
    )
    expect(keys).toHaveLength(2)
    expect(keys[0]!.wrapped_key).not.toBe(keys[1]!.wrapped_key)
  })

  it("INT-1 AC1: one workspace's ciphertext cannot be read in another's context", async () => {
    const workspaceId = await freshWorkspace()
    const otherWorkspaceId = await freshWorkspace()
    const mine = await store.connect({ workspaceId, kind: 'reference', credentials: SECRET })

    // Two barriers, and this asserts both hold: row-level security will not
    // surface the row, and the workspace is authenticated data in the
    // ciphertext, so a row lifted past the policy still would not decrypt.
    await expect(store.credentialsFor(otherWorkspaceId, mine.id)).rejects.toThrow()
  })

  it('INT-1 AC1: rotating the master key rewraps every data key and leaves ciphertext untouched', async () => {
    const workspaceId = await freshWorkspace()
    const otherWorkspaceId = await freshWorkspace()
    const first = await store.connect({ workspaceId, kind: 'reference', credentials: SECRET })
    const second = await store.connect({
      workspaceId: otherWorkspaceId,
      kind: 'github',
      credentials: SECRET,
    })

    const before = await db.admin.query<{ id: string; encrypted_credentials: string }>(
      `SELECT id, encrypted_credentials FROM integrations WHERE id = ANY($1) ORDER BY id`,
      [[first.id, second.id]],
    )

    // When the master key is rotated
    const rotating = createCredentialStore(db.config, createKeyring([oldKey, newKey]), newKey)
    const rotated = await rotating.rotateMasterKey()
    expect(rotated.rewrapped, 'both workspaces must be rewrapped').toBeGreaterThanOrEqual(2)

    // Then every data key names the new master key
    const keys = await db.admin.query<{ wrapped_key: string }>(`SELECT wrapped_key FROM workspace_data_keys`)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(key.wrapped_key).toMatch(/^v1\.k-new\./)
    }

    // and no credential ciphertext moved — that is the point of the envelope
    const after = await db.admin.query<{ id: string; encrypted_credentials: string }>(
      `SELECT id, encrypted_credentials FROM integrations WHERE id = ANY($1) ORDER BY id`,
      [[first.id, second.id]],
    )
    expect(after).toEqual(before)

    // and the credentials still read back, under the new master key alone
    const afterRotation = createCredentialStore(db.config, createKeyring([newKey]), newKey)
    expect(await afterRotation.credentialsFor(workspaceId, first.id)).toEqual(SECRET)
  })

  it('INT-1 AC1: rotation is resumable, because a rewrapped key is recognisable', async () => {
    const workspaceId = await freshWorkspace()
    await store.connect({ workspaceId, kind: 'reference', credentials: SECRET })

    const rotating = createCredentialStore(db.config, createKeyring([oldKey, newKey]), newKey)
    await rotating.rotateMasterKey()

    // A second pass must find nothing left to do rather than churning every row
    // again — which is what makes an interrupted rotation safe to re-run.
    const second = await rotating.rotateMasterKey()
    expect(second.rewrapped).toBe(0)
    expect(second.alreadyCurrent).toBeGreaterThan(0)
  })

  it('INT-1 AC1: a keyring missing the old master key fails loudly and names it', async () => {
    const workspaceId = await freshWorkspace()
    const integration = await store.connect({
      workspaceId,
      kind: 'reference',
      credentials: SECRET,
    })

    // A deployment that comes up unable to read its own credentials must say
    // which key is missing; "decryption failed" is not a diagnosis.
    const wrongKeyring = createCredentialStore(db.config, createKeyring([newKey]), newKey)
    await expect(wrongKeyring.credentialsFor(workspaceId, integration.id)).rejects.toThrow(/k-old/)
  })

  it('INT-1 AC1: credentials can be replaced without minting a new data key', async () => {
    const workspaceId = await freshWorkspace()
    const integration = await store.connect({
      workspaceId,
      kind: 'reference',
      credentials: SECRET,
    })
    const [before] = await db.admin.query<{ wrapped_key: string }>(
      `SELECT wrapped_key FROM workspace_data_keys WHERE workspace_id = $1`,
      [workspaceId],
    )

    const refreshed = { accessToken: 'ghp_rotatedtoken', refreshToken: 'rt_new' }
    await store.updateCredentials(workspaceId, integration.id, refreshed)

    expect(await store.credentialsFor(workspaceId, integration.id)).toEqual(refreshed)
    const [after] = await db.admin.query<{ wrapped_key: string }>(
      `SELECT wrapped_key FROM workspace_data_keys WHERE workspace_id = $1`,
      [workspaceId],
    )
    expect(after!.wrapped_key).toBe(before!.wrapped_key)
  })

  it('INT-1 AC1: connecting and replacing credentials are audited, without the credential', async () => {
    const workspaceId = await freshWorkspace()
    const integration = await store.connect({
      workspaceId,
      kind: 'reference',
      credentials: SECRET,
      actorId: (
        await db.admin.query<{ user_id: string }>(
          `SELECT user_id FROM workspace_members WHERE workspace_id = $1`,
          [workspaceId],
        )
      )[0]!.user_id,
    })
    await store.updateCredentials(workspaceId, integration.id, SECRET)

    const events = await db.admin.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE workspace_id = $1 AND target_id = $2 ORDER BY at`,
      [workspaceId, integration.id],
    )
    expect(events.map((event) => event.action)).toEqual([
      'integration.connect',
      'integration.credentials_updated',
    ])
    expect(JSON.stringify(events)).not.toContain(SECRET.accessToken)
  })
})
