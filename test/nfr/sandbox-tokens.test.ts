import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createKeyring, parseMasterKey, ulid } from '@chorus/core'
import {
  createCredentialStore,
  createGitHubConnector,
  type CredentialStore,
} from '@chorus/connectors'
import { cassettePlayer, contractContext } from '@chorus/connectors/testing'

/**
 * INT-2 AC2 — repository-scoped tokens for coding sandboxes.
 *
 * This is a **security control**, not a convenience, so it lives in the
 * cross-cutting suite that runs on every pull request rather than beside the
 * connector. The failure it guards against is the one that does not look like a
 * failure: a token that works perfectly, and happens to reach every repository
 * in the organisation.
 *
 * Three properties, and all three have to hold at once. A token that is scoped
 * but long-lived is a persistent key to one repository. One that is short-lived
 * but broad is an hour of access to everything. One that is both, but stored, is
 * a long-lived token with extra steps.
 */
describe('INT-2 AC2 sandbox repository tokens', () => {
  let db: IsolatedDatabase
  let store: CredentialStore
  const master = parseMasterKey('k1', randomBytes(32).toString('base64'))
  const frozen = new Date('2026-09-02T12:00:00.000Z')

  const LINKED = 'acme/widgets'
  const OTHER = 'acme/secrets'

  async function connected(): Promise<{ workspaceId: string; integrationId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM integrations WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM workspace_data_keys WHERE workspace_id = $1`, [workspaceId])
    const integration = await store.connect({
      workspaceId,
      kind: 'github',
      credentials: { installationToken: 'ghs_installation', appJwt: 'jwt-for-the-app' },
      config: { installationId: '12345', repositories: [LINKED] },
    })
    return { workspaceId, integrationId: integration.id }
  }

  const ctxFor = async (workspaceId: string, integrationId: string, cassette: string) =>
    contractContext({
      workspaceId,
      integrationId,
      credentials: await store.credentialsFor(workspaceId, integrationId),
      config: (await store.get(workspaceId, integrationId)).config,
      now: () => frozen,
      fetch: cassettePlayer(cassette),
    })

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    store = createCredentialStore(db.config, createKeyring([master]), master)
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('INT-2 AC2: a minted token names exactly one repository and least-privilege permissions', async () => {
    const { workspaceId, integrationId } = await connected()
    const requests: Array<{ url: string; body: unknown }> = []

    const player = cassettePlayer('github/mint-token.json')
    const recording: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return player(input, init)
    }

    const connector = createGitHubConnector()
    const ctx = contractContext({
      workspaceId,
      integrationId,
      credentials: await store.credentialsFor(workspaceId, integrationId),
      config: (await store.get(workspaceId, integrationId)).config,
      now: () => frozen,
      fetch: recording,
    })

    await connector.mintRepositoryToken(LINKED, ctx)

    expect(requests).toHaveLength(1)
    const body = requests[0]!.body as { repositories: string[]; permissions: Record<string, string> }
    // One repository, named. An omitted `repositories` array is what GitHub
    // treats as "all of them", so its presence is the control.
    expect(body.repositories).toEqual(['widgets'])
    expect(body.permissions).toEqual({ contents: 'read', metadata: 'read' })
    expect(
      Object.values(body.permissions),
      'a sandbox clone token must not carry write',
    ).not.toContain('write')
  })

  it('INT-2 AC2: a minted token expires within the hour', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createGitHubConnector()

    const minted = await connector.mintRepositoryToken(
      LINKED,
      await ctxFor(workspaceId, integrationId, 'github/mint-token.json'),
    )

    const lifetimeMs = minted.expiresAt.getTime() - frozen.getTime()
    expect(lifetimeMs).toBeGreaterThan(0)
    expect(lifetimeMs, 'a sandbox token must not outlive the job it was minted for').toBeLessThanOrEqual(
      60 * 60 * 1000,
    )
  })

  it('INT-2 AC2: a token cannot be minted for a repository this integration is not linked to', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createGitHubConnector()

    // The caller does not widen the grant by asking. An installation may have
    // access to repositories a workspace never linked, and a coding job must
    // not be able to reach them by naming one.
    await expect(
      connector.mintRepositoryToken(
        OTHER,
        await ctxFor(workspaceId, integrationId, 'github/mint-token.json'),
      ),
    ).rejects.toThrow(/not linked/i)
  })

  it('INT-2 AC2: a minted token is never persisted anywhere', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createGitHubConnector()

    const minted = await connector.mintRepositoryToken(
      LINKED,
      await ctxFor(workspaceId, integrationId, 'github/mint-token.json'),
    )

    // Storing a short-lived token turns it into a long-lived one. Every table
    // that could plausibly hold it is checked, not just the obvious one.
    for (const table of ['integrations', 'workspace_data_keys', 'audit_events', 'signals']) {
      const rows = await db.admin.query<Record<string, unknown>>(
        `SELECT * FROM ${table} WHERE workspace_id = $1`,
        [workspaceId],
      )
      expect(
        JSON.stringify(rows),
        `${table} must not contain the minted token`,
      ).not.toContain(minted.token)
    }
  })

  it('INT-2 AC2: the stored installation credentials are still only ciphertext', async () => {
    const { workspaceId, integrationId } = await connected()
    const connector = createGitHubConnector()
    await connector.mintRepositoryToken(
      LINKED,
      await ctxFor(workspaceId, integrationId, 'github/mint-token.json'),
    )

    const [row] = await db.admin.query<Record<string, unknown>>(
      `SELECT * FROM integrations WHERE id = $1`,
      [integrationId],
    )
    const serialised = JSON.stringify(row)
    expect(serialised).not.toContain('ghs_installation')
    expect(serialised).not.toContain('jwt-for-the-app')
  })

  it('INT-2 AC2: minting refuses an integration that records no installation', async () => {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM integrations WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM workspace_data_keys WHERE workspace_id = $1`, [workspaceId])
    const integration = await store.connect({
      workspaceId,
      kind: 'github',
      credentials: { installationToken: 'ghs_installation' },
      config: { repositories: [LINKED] },
    })

    // Failing loudly beats minting against a guessed installation, which would
    // either fail confusingly or succeed against the wrong account.
    await expect(
      createGitHubConnector().mintRepositoryToken(
        LINKED,
        await ctxFor(workspaceId, integration.id, 'github/mint-token.json'),
      ),
    ).rejects.toThrow(/installation id/i)
  })
})
