import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createRetriever, createScopeMemberships } from '@chorus/brain'
import { createConfluenceConnector, type ConnectorContext } from '@chorus/connectors'
import { cassettePlayer } from '@chorus/connectors/testing'
import { createFakeModelProvider } from '@chorus/testing'
import { createConfluenceMembershipSync } from '../../src/membership-sync.js'

/**
 * NFR-4 AC1 / AND1 — Confluence group membership becomes access, for the people
 * who linked their own Atlassian account.
 *
 * The groups that matter are the ones restricted pages actually name. Each is
 * read from Confluence; every person who linked an Atlassian account (ADR-0024)
 * is granted exactly the groups that account is in, plus their own
 * `confluence:user:` scope for pages restricted to them by name. Someone in a
 * group who never linked gains nothing — there is no email fallback. A person
 * who leaves a group upstream loses it on the next sync, and a sync that cannot
 * read a group changes nothing rather than revoking or granting on half the
 * picture.
 */
describe('NFR-4 Confluence membership sync', () => {
  let db: IsolatedDatabase

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  async function world() {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    for (const table of ['source_scope_memberships', 'linked_accounts', 'signals']) {
      await db.admin.execute(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId])
    }
    const [team] = await db.admin.query<{ id: string }>(`SELECT id FROM teams WHERE workspace_id = $1 LIMIT 1`, [
      workspaceId,
    ])
    const integrationId = ulid()
    await db.admin.execute(`INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'confluence')`, [
      integrationId,
      workspaceId,
    ])

    const person = async (name: string, atlassianAccount?: string) => {
      const id = ulid()
      await db.admin.execute(`INSERT INTO users (id, email, name, email_verified) VALUES ($1, $2, $3, true)`, [
        id,
        `${name}-${id}@example.test`,
        name,
      ])
      await db.admin.execute(
        `INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES ($1, $2, $3, 'member')`,
        [ulid(), workspaceId, id],
      )
      if (atlassianAccount) {
        await db.admin.execute(
          `INSERT INTO linked_accounts (id, workspace_id, user_id, provider, account_id) VALUES ($1, $2, $3, 'atlassian', $4)`,
          [ulid(), workspaceId, id, atlassianAccount],
        )
      }
      return id
    }
    const ada = await person('ada', 'acc-ada')
    const grace = await person('grace', 'acc-grace')
    const bob = await person('bob') // in the finance group upstream, but never linked

    const page = async (text: string, scopeIds: string[]) =>
      db.admin.execute(
        `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions)
         VALUES ($1, $2, $3, 'confluence', $1, 'page', $4, now(), $5::jsonb)`,
        [ulid(), workspaceId, integrationId, text, JSON.stringify({ visibility: 'restricted', scopeIds })],
      )
    await page('the finance forecast is confidential', ['confluence:group:finance'])
    await page('the eng roadmap is internal', ['confluence:group:eng'])
    await page('a note only grace may read', ['confluence:user:acc-grace'])

    return { workspaceId, teamId: team!.id, integrationId, ada, grace, bob }
  }

  const ctxFor = (w: Awaited<ReturnType<typeof world>>, cassette: string): ConnectorContext => ({
    workspaceId: w.workspaceId,
    integrationId: w.integrationId,
    credentials: { accessToken: 'confluence_access' },
    config: { siteUrl: 'https://acme.atlassian.net' },
    now: () => new Date('2026-11-14T12:00:00Z'),
    fetch: cassettePlayer(cassette),
    saveCredentials: async () => {},
  })

  const runSync = (w: Awaited<ReturnType<typeof world>>, cassette: string) =>
    createConfluenceMembershipSync({
      config: db.config,
      connector: createConfluenceConnector({ apiUrl: 'https://confluence.test/api', fetch: cassettePlayer(cassette) }),
      memberships: createScopeMemberships(db.config),
    }).sync(ctxFor(w, cassette))

  const scopesOf = async (w: Awaited<ReturnType<typeof world>>, userId: string) =>
    (await createScopeMemberships(db.config).scopesFor(w.workspaceId, userId)).sort()

  it('NFR-4 AC1: linked people gain exactly their groups and their own user scope; the unlinked gain nothing', async () => {
    const w = await world()
    const outcome = await runSync(w, 'confluence/membership-sync.json')

    expect(outcome).toMatchObject({ groups: 2, linkedPeople: 2 })
    expect(await scopesOf(w, w.ada)).toEqual(['confluence:group:finance', 'confluence:user:acc-ada'])
    expect(await scopesOf(w, w.grace)).toEqual(['confluence:group:eng', 'confluence:user:acc-grace'])
    expect(await scopesOf(w, w.bob), 'no link, no access — there is no email fallback').toEqual([])
  })

  it('NFR-4 AC1: after a sync, retrieval shows each person exactly the pages their groups allow', async () => {
    const w = await world()
    await runSync(w, 'confluence/membership-sync.json')
    const retriever = createRetriever(db.config, {
      models: createFakeModelProvider(),
      embeddingModel: { provider: 'fake', model: 'fake-embed' },
    })
    const pagesFor = async (userId: string) =>
      (
        await retriever.retrieve({
          workspaceId: w.workspaceId,
          teamId: w.teamId,
          userId,
          query: 'finance forecast eng roadmap note grace',
          kinds: ['signal'],
          k: 10,
        })
      ).fragments
        .map((f) => f.text)
        .sort()

    expect(await pagesFor(w.ada)).toEqual(['the finance forecast is confidential'])
    expect(await pagesFor(w.grace)).toEqual(['a note only grace may read', 'the eng roadmap is internal'])
    expect(await pagesFor(w.bob)).toEqual([])
  })

  it('NFR-4 AND1: someone who leaves a group upstream loses it on the next sync', async () => {
    const w = await world()
    await runSync(w, 'confluence/membership-sync.json')
    await runSync(w, 'confluence/membership-sync-left.json')

    expect(await scopesOf(w, w.ada)).toEqual(['confluence:user:acc-ada'])
    expect(await scopesOf(w, w.grace)).toEqual(['confluence:group:eng', 'confluence:user:acc-grace'])
  })

  it('NFR-4: a sync that cannot read a group changes nothing', async () => {
    const w = await world()
    await runSync(w, 'confluence/membership-sync.json')

    await expect(runSync(w, 'confluence/membership-sync-failed.json')).rejects.toThrow()

    // Half a picture must not grant or revoke: everyone keeps what they had.
    expect(await scopesOf(w, w.ada)).toEqual(['confluence:group:finance', 'confluence:user:acc-ada'])
    expect(await scopesOf(w, w.grace)).toEqual(['confluence:group:eng', 'confluence:user:acc-grace'])
  })
})
