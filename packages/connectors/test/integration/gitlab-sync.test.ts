import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createKeyring, parseMasterKey, ulid } from '@chorus/core'
import { createCredentialStore, type CredentialStore } from '../../src/credentials.js'
import { createSyncRunner } from '../../src/sync.js'
import { createWebhookReceiver } from '../../src/webhooks.js'
import { createGitLabConnector } from '../../src/gitlab/index.js'
import { cassettePlayer } from '../../src/testing/cassettes.js'

/**
 * INT-2 — the GitLab connector through the real framework.
 *
 * The property worth a database is **credential rotation surviving the round
 * trip**. GitLab rotates its refresh token on every use, so a connector that
 * refreshes and does not persist the new one works perfectly today and dies
 * silently at the next expiry, with nothing in the logs to say why. Only a test
 * that reads the credential back out of the store afterwards can see that.
 */
describe('INT-2 GitLab connector', () => {
  let db: IsolatedDatabase
  let store: CredentialStore
  const master = parseMasterKey('k1', randomBytes(32).toString('base64'))
  const frozen = new Date('2026-09-02T12:00:00.000Z')
  const PROJECT = 'acme/widgets'
  const WEBHOOK_TOKEN = 'gitlab-webhook-token'

  async function connected(
    credentials: Record<string, string> = {},
    config: Record<string, unknown> = {},
  ): Promise<{ workspaceId: string; integrationId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM integrations WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM workspace_data_keys WHERE workspace_id = $1`, [workspaceId])
    const integration = await store.connect({
      workspaceId,
      kind: 'gitlab',
      credentials: {
        accessToken: 'glpat-original',
        refreshToken: 'refresh-original',
        webhookToken: WEBHOOK_TOKEN,
        ...credentials,
      },
      config: { projects: [PROJECT], privateProjects: [PROJECT], ...config },
    })
    return { workspaceId, integrationId: integration.id }
  }

  const signalsIn = (workspaceId: string) =>
    db.admin.query<{
      external_id: string
      kind: string
      permissions: { visibility: string; scopeIds: string[] }
      structured: Record<string, unknown>
      occurred_at: Date
    }>(
      `SELECT external_id, kind, permissions, structured, occurred_at
         FROM signals WHERE workspace_id = $1 ORDER BY external_id`,
      [workspaceId],
    )

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    store = createCredentialStore(db.config, createKeyring([master]), master)
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('INT-2 AC1: a full sync of a linked project surfaces its activity as signals', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    const outcome = await runner.sync(
      workspaceId,
      integrationId,
      createGitLabConnector({ fetch: cassettePlayer('gitlab/pull.json') }),
    )

    expect(outcome.state).toBe('caught_up')
    expect(new Set((await signalsIn(workspaceId)).map((row) => row.kind))).toEqual(
      new Set([
        'commit',
        'merge_request',
        'review',
        'issue',
        'issue_comment',
        'deployment',
        'workflow_run',
      ]),
    )
  })

  it('INT-2: a refreshed access token AND the rotated refresh token are both persisted', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    await runner.sync(
      workspaceId,
      integrationId,
      createGitLabConnector({
        fetch: cassettePlayer('gitlab/refresh.json'),
        clientId: 'chorus-gitlab-app',
        clientSecret: 'chorus-gitlab-secret',
      }),
    )

    const stored = await store.credentialsFor(workspaceId, integrationId)
    expect(stored.accessToken).toBe('glpat-refreshed')
    // The one that actually matters. GitLab invalidates the old refresh token
    // the moment it is used, so keeping it would work exactly once more and
    // then fail with nothing to explain it.
    expect(stored.refreshToken, 'the rotated refresh token must replace the old one').toBe(
      'refresh-rotated',
    )
    // Unrelated credentials must survive a refresh untouched.
    expect(stored.webhookToken).toBe(WEBHOOK_TOKEN)
  })

  it('INT-2: refreshed credentials are stored encrypted, like any other', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    await runner.sync(
      workspaceId,
      integrationId,
      createGitLabConnector({
        fetch: cassettePlayer('gitlab/refresh.json'),
        clientId: 'chorus-gitlab-app',
      }),
    )

    const [row] = await db.admin.query<Record<string, unknown>>(
      `SELECT * FROM integrations WHERE id = $1`,
      [integrationId],
    )
    expect(JSON.stringify(row)).not.toContain('glpat-refreshed')
    expect(JSON.stringify(row)).not.toContain('refresh-rotated')
  })

  it('INT-2: a credential refresh is audited, without the credential', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    await runner.sync(
      workspaceId,
      integrationId,
      createGitLabConnector({
        fetch: cassettePlayer('gitlab/refresh.json'),
        clientId: 'chorus-gitlab-app',
      }),
    )

    const events = await db.admin.query<{ action: string; after: Record<string, unknown> }>(
      `SELECT action, after FROM audit_events
        WHERE workspace_id = $1 AND action = 'integration.credentials_updated'`,
      [workspaceId],
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.after.credentialKeys).toEqual(['accessToken', 'refreshToken', 'webhookToken'])
    expect(JSON.stringify(events)).not.toContain('glpat-refreshed')
  })

  it('INT-2: without a usable refresh token the sync fails rather than looping', async () => {
    const { workspaceId, integrationId } = await connected({ refreshToken: '' })
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    const outcome = await runner.sync(
      workspaceId,
      integrationId,
      createGitLabConnector({ fetch: cassettePlayer('gitlab/credential-expired.json') }),
    )

    expect(outcome.state).toBe('failed')
    const [row] = await db.admin.query<{ status: string; health: Record<string, unknown> }>(
      `SELECT status, health FROM integrations WHERE id = $1`,
      [integrationId],
    )
    expect(row!.status).toBe('failed')
    expect(String(row!.health.lastError)).toMatch(/401/)
  })

  it('INT-2 AC7: a private project’s signals are restricted, scoped to that project', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    await runner.sync(
      workspaceId,
      integrationId,
      createGitLabConnector({ fetch: cassettePlayer('gitlab/pull.json') }),
    )

    for (const row of await signalsIn(workspaceId)) {
      expect(row.permissions.visibility).toBe('restricted')
      expect(row.permissions.scopeIds).toEqual([`gitlab:project:${PROJECT}`])
    }
  })

  it('INT-2: a merge request is identified by its project-scoped iid, not its instance id', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    await runner.sync(
      workspaceId,
      integrationId,
      createGitLabConnector({ fetch: cassettePlayer('gitlab/pull.json') }),
    )

    const rows = await signalsIn(workspaceId)
    // `iid` is what the GitLab UI shows. Using the instance-wide `id` would make
    // an external id nobody could match against what they are looking at.
    expect(rows.find((row) => row.kind === 'merge_request')!.external_id).toBe(`${PROJECT}#mr-42`)
    expect(rows.find((row) => row.kind === 'issue')!.external_id).toBe(`${PROJECT}#issue-7`)
  })

  it('INT-2: a pipeline is normalised to the same shape as a GitHub workflow run', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    await runner.sync(
      workspaceId,
      integrationId,
      createGitLabConnector({ fetch: cassettePlayer('gitlab/pull.json') }),
    )

    // Anything downstream should read one vocabulary, not two providers'.
    const run = (await signalsIn(workspaceId)).find((row) => row.kind === 'workflow_run')!
    expect(run.structured).toMatchObject({ status: 'success', headBranch: 'fix/deploy-timeout' })
    expect(String(run.structured.headSha)).toHaveLength(40)
  })

  it("INT-2: a webhook timestamp in GitLab's own format is parsed, not rejected", async () => {
    // GitLab's REST API returns ISO-8601 but its webhooks use
    // `2026-09-01 09:00:00 UTC`, which `Date` cannot parse. Getting this wrong
    // misfiles every webhook-sourced signal while the pulled ones look fine.
    const { workspaceId, integrationId } = await connected()
    const receiver = createWebhookReceiver(db.config, store, { now: () => frozen })

    const body = JSON.stringify({
      object_kind: 'issue',
      project: { id: 77, path_with_namespace: PROJECT },
      object_attributes: {
        id: 3001,
        iid: 7,
        title: 'The deploy step times out',
        description: 'It hangs after the build.',
        state: 'opened',
        url: `https://gitlab.com/${PROJECT}/-/issues/7`,
        created_at: '2026-09-01 08:00:00 UTC',
        updated_at: '2026-09-01 09:10:00 UTC',
      },
      user: { id: 501, username: 'ada' },
    })

    const outcome = await receiver.receive(workspaceId, integrationId, createGitLabConnector(), {
      headers: {
        'x-gitlab-event-uuid': 'gl-1',
        'x-gitlab-event': 'Issue Hook',
        'x-gitlab-token': WEBHOOK_TOKEN,
      },
      body,
    })

    expect(outcome.state).toBe('processed')
    const [row] = await signalsIn(workspaceId)
    expect(row!.occurred_at.toISOString()).toBe('2026-09-01T09:10:00.000Z')
  })

  it('INT-2: a delivery presenting the wrong shared token is refused', async () => {
    const { workspaceId, integrationId } = await connected()
    const receiver = createWebhookReceiver(db.config, store, { now: () => frozen })

    const outcome = await receiver.receive(workspaceId, integrationId, createGitLabConnector(), {
      headers: { 'x-gitlab-event-uuid': 'gl-2', 'x-gitlab-token': 'not-the-token' },
      body: JSON.stringify({ object_kind: 'issue' }),
    })

    expect(outcome.state).toBe('rejected')
    expect(await signalsIn(workspaceId)).toHaveLength(0)
  })

  it('INT-2: a push and a later sync agree on what a commit is called', async () => {
    const { workspaceId, integrationId } = await connected()
    const receiver = createWebhookReceiver(db.config, store, { now: () => frozen })
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    await receiver.receive(workspaceId, integrationId, createGitLabConnector(), {
      headers: { 'x-gitlab-event-uuid': 'gl-push-1', 'x-gitlab-token': WEBHOOK_TOKEN },
      body: JSON.stringify({
        object_kind: 'push',
        ref: 'refs/heads/main',
        project: { path_with_namespace: PROJECT },
        commits: [
          {
            id: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
            message: 'Fix the deploy timeout',
            timestamp: '2026-09-01T09:00:00+00:00',
            url: `https://gitlab.com/${PROJECT}/-/commit/a1b2c3d`,
            author: { name: 'Ada Lovelace', email: 'ada@example.test' },
            added: [],
            modified: ['src/deploy.ts'],
            removed: [],
          },
        ],
      }),
    })

    const outcome = await runner.sync(
      workspaceId,
      integrationId,
      createGitLabConnector({ fetch: cassettePlayer('gitlab/pull.json') }),
    )

    const commits = (await signalsIn(workspaceId)).filter((row) => row.kind === 'commit')
    expect(commits).toHaveLength(1)
    expect(outcome.duplicates, 'the sync must recognise the pushed commit').toBeGreaterThan(0)
  })

  it('INT-2: a rate-limited sync honours the delay GitLab asked for', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    const outcome = await runner.sync(
      workspaceId,
      integrationId,
      createGitLabConnector({ fetch: cassettePlayer('gitlab/rate-limited.json') }),
    )

    expect(outcome.state).toBe('rate_limited')
    expect(outcome.retryAfterMs).toBe(45_000)
  })
})
