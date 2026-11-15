import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createScopeMemberships } from '@chorus/brain'
import { createApp } from '../../src/app.js'
import {
  createFakeIdentityProvider,
  createRecordingMailer,
  createTestClient,
  type FakeIdentityProvider,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * NFR-4 AC1 / AND1 — a person links their own Atlassian account, explicitly.
 *
 * Restricted Confluence pages reach a Chorus user only through the Atlassian
 * account *they* proved they own (Dan's decision: explicit link only, no email
 * matching). The flow is the first OAuth client flow in the API, so it is built
 * against the classic account-linking attack: someone starts a link and tricks
 * another signed-in person into completing it, binding the victim's Atlassian
 * account — and so the victim's group access — to the attacker. A link request
 * is single-use, short-lived, and completes only for the person who started it.
 * Unlinking revokes that person's Atlassian-derived scopes at once.
 */
interface LinkedAccounts {
  accounts: Array<{ provider: string; accountId: string }>
}

describe('NFR-4 Atlassian account linking', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let atlassian: FakeIdentityProvider

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    // The fake proves the code it is handed: `ada-code` belongs to Atlassian account `acc-ada`.
    atlassian = createFakeIdentityProvider({
      provider: 'atlassian',
      accounts: { 'ada-code': 'acc-ada', 'grace-code': 'acc-grace', 'ada-again': 'acc-ada' },
    })
    client = createTestClient(
      createApp({ dbConfig: db.config, mailer, identityProviders: { atlassian } }),
      mailer,
    )
  })

  async function startLink(user: SignedInUser, workspaceId: string): Promise<string> {
    const res = await user.post(`/workspaces/${workspaceId}/me/linked-accounts/atlassian`, {})
    expect(res.status, await res.clone().text()).toBe(200)
    const { authorizationUrl } = (await res.json()) as { authorizationUrl: string }
    return new URL(authorizationUrl).searchParams.get('state')!
  }

  const complete = (user: SignedInUser, code: string, state: string) =>
    user.get(`/oauth/atlassian/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`)

  async function linkedFor(user: SignedInUser, workspaceId: string): Promise<LinkedAccounts> {
    const res = await user.get(`/workspaces/${workspaceId}/me/linked-accounts`)
    expect(res.status, await res.clone().text()).toBe(200)
    return (await res.json()) as LinkedAccounts
  }

  it('NFR-4 AC1: a person links the Atlassian account they proved they own, and it is audited', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Linked')

    const state = await startLink(ada, workspace.id)
    const done = await complete(ada, 'ada-code', state)
    expect(done.status, await done.clone().text()).toBe(200)

    expect(await linkedFor(ada, workspace.id)).toEqual({ accounts: [{ provider: 'atlassian', accountId: 'acc-ada' }] })
    // PKCE was used end to end: the code was exchanged with the verifier matching the challenge.
    expect(atlassian.exchanges).toEqual([{ code: 'ada-code', verifierMatched: true }])
    const audit = await db.admin.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_events WHERE workspace_id = $1 AND action LIKE 'linked_account.%'`,
      [workspace.id],
    )
    expect(audit).toEqual([{ action: 'linked_account.link', actor_id: ada.userId }])
  })

  it('NFR-4 AC1: a link request completed by someone other than its starter is refused', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Hijack')
    const grace = await client.memberWithRole(ada, workspace.id, 'member')

    // Ada starts a link; Grace is tricked into completing it with her own Atlassian login.
    const state = await startLink(ada, workspace.id)
    const hijack = await complete(grace, 'grace-code', state)
    expect(hijack.status).toBe(403)

    // Nobody is linked — least of all Ada to Grace's account.
    expect(await linkedFor(ada, workspace.id)).toEqual({ accounts: [] })
    expect(await linkedFor(grace, workspace.id)).toEqual({ accounts: [] })
    expect(atlassian.exchanges, 'the code is never exchanged for the wrong person').toEqual([])
  })

  it('NFR-4 AC1: a link request is single-use', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Replay')
    const state = await startLink(ada, workspace.id)
    expect((await complete(ada, 'ada-code', state)).status).toBe(200)

    expect((await complete(ada, 'ada-code', state)).status).toBe(400)
  })

  it('NFR-4 AC1: an expired link request is refused', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Expired')
    const state = await startLink(ada, workspace.id)
    await db.admin.execute(
      `UPDATE account_link_requests SET expires_at = now() - interval '1 minute' WHERE workspace_id = $1`,
      [workspace.id],
    )

    expect((await complete(ada, 'ada-code', state)).status).toBe(400)
    expect(await linkedFor(ada, workspace.id)).toEqual({ accounts: [] })
  })

  it('NFR-4 AC1: one Atlassian account cannot be claimed by two people in a workspace', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Claimed')
    const grace = await client.memberWithRole(ada, workspace.id, 'member')
    expect((await complete(ada, 'ada-code', await startLink(ada, workspace.id))).status).toBe(200)

    // Grace somehow proves the same Atlassian account.
    const second = await complete(grace, 'ada-again', await startLink(grace, workspace.id))
    expect(second.status).toBe(409)
    expect(await linkedFor(grace, workspace.id)).toEqual({ accounts: [] })
  })

  it('NFR-4 AND1: unlinking revokes the person’s Atlassian-derived scopes at once, and is audited', async () => {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Unlink')
    expect((await complete(ada, 'ada-code', await startLink(ada, workspace.id))).status).toBe(200)
    // A membership sync has granted her the finance group, and Slack gave her a channel.
    const memberships = createScopeMemberships(db.config)
    const sync = (source: string, scopeIds: string[]) =>
      memberships.replace({ workspaceId: workspace.id, userId: ada.userId, source, scopeIds, actor: { type: 'system' } })
    await sync('confluence', ['confluence:group:finance'])
    await sync('slack', ['slack:channel:general'])

    const res = await ada.delete(`/workspaces/${workspace.id}/me/linked-accounts/atlassian`)
    expect(res.status, await res.clone().text()).toBe(200)

    expect(await linkedFor(ada, workspace.id)).toEqual({ accounts: [] })
    // Confluence access is gone immediately — no waiting for the next sync — and Slack's is untouched.
    expect(await memberships.scopesFor(workspace.id, ada.userId)).toEqual(['slack:channel:general'])
    const audit = await db.admin.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE workspace_id = $1 AND action = 'linked_account.unlink'`,
      [workspace.id],
    )
    expect(audit).toHaveLength(1)
  })

  it('NFR-4: without an Atlassian client configured, starting a link says so', async () => {
    const mailer = createRecordingMailer()
    const unconfigured = createTestClient(createApp({ dbConfig: db.config, mailer }), mailer)
    const ada = await unconfigured.signedInUser()
    const workspace = await ada.createWorkspace('Unconfigured')

    const res = await ada.post(`/workspaces/${workspace.id}/me/linked-accounts/atlassian`, {})
    expect(res.status).toBe(500)
    expect(await res.text()).toMatch(/not configured/i)
  })
})
