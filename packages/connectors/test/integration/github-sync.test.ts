import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHmac, randomBytes } from 'node:crypto'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createKeyring, parseMasterKey, ulid } from '@chorus/core'
import { createCredentialStore, type CredentialStore } from '../../src/credentials.js'
import { createSyncRunner } from '../../src/sync.js'
import { createWebhookReceiver } from '../../src/webhooks.js'
import { createGitHubConnector } from '../../src/github/index.js'
import { cassettePlayer } from '../../src/testing/cassettes.js'

/**
 * INT-2 — the GitHub connector through the real framework, into a real database.
 *
 * The contract suite proves the connector honours the interface. This proves
 * the two halves fit: that GitHub's shapes survive the envelope, that a private
 * repository's activity lands restricted, and that a push and a later sync
 * agree on what a commit is called — which they must, because the dedup key is
 * the external id and disagreement means the same commit stored twice under two
 * names.
 */
describe('INT-2 GitHub connector', () => {
  let db: IsolatedDatabase
  let store: CredentialStore
  const master = parseMasterKey('k1', randomBytes(32).toString('base64'))
  const frozen = new Date('2026-09-02T12:00:00.000Z')
  const REPO = 'acme/widgets'
  const SECRET = 'github-webhook-secret'

  async function connected(
    config: Record<string, unknown> = {},
  ): Promise<{ workspaceId: string; integrationId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM integrations WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM workspace_data_keys WHERE workspace_id = $1`, [workspaceId])
    const integration = await store.connect({
      workspaceId,
      kind: 'github',
      credentials: { installationToken: 'ghs_installation', webhookSecret: SECRET },
      config: { installationId: '12345', repositories: [REPO], ...config },
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

  function delivery(id: string, event: string, payload: unknown) {
    const body = JSON.stringify(payload)
    return {
      headers: {
        'x-github-delivery': id,
        'x-github-event': event,
        'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
      },
      body,
    }
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    store = createCredentialStore(db.config, createKeyring([master]), master)
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('INT-2 AC1: a full sync of a linked repository surfaces its activity as signals', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })
    const connector = createGitHubConnector({ fetch: cassettePlayer('github/pull.json') })

    const outcome = await runner.sync(workspaceId, integrationId, connector)

    expect(outcome.state).toBe('caught_up')
    const rows = await signalsIn(workspaceId)

    // Every stream the connector walks must have produced something, or a
    // resource has silently stopped being ingested.
    expect(new Set(rows.map((row) => row.kind))).toEqual(
      new Set([
        'commit',
        'pull_request',
        'review',
        'issue',
        'issue_comment',
        'deployment',
        'workflow_run',
      ]),
    )
  })

  it('INT-2 AC7: a private repository’s signals are restricted, scoped to that repository', async () => {
    const { workspaceId, integrationId } = await connected({ privateRepositories: [REPO] })
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    await runner.sync(
      workspaceId,
      integrationId,
      createGitHubConnector({ fetch: cassettePlayer('github/pull.json') }),
    )

    for (const row of await signalsIn(workspaceId)) {
      expect(row.permissions.visibility, `${row.external_id} must be restricted`).toBe('restricted')
      // Scoped to the repository, not the installation: access is granted per
      // repository, so an installation-wide scope leaks between them.
      expect(row.permissions.scopeIds).toEqual([`github:repo:${REPO}`])
    }
  })

  it('INT-2 AC7: an unknown repository is treated as private, not as public', async () => {
    // `privateRepositories` is absent here. Over-restricting hides data from
    // someone who could have seen it; under-restricting shows it to someone who
    // could not, and only one of those is recoverable.
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    await runner.sync(
      workspaceId,
      integrationId,
      createGitHubConnector({ fetch: cassettePlayer('github/pull.json') }),
    )

    const rows = await signalsIn(workspaceId)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.permissions.visibility === 'restricted')).toBe(true)
  })

  it('INT-2 AC4: deployments and workflow runs carry what preview discovery needs', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    await runner.sync(
      workspaceId,
      integrationId,
      createGitHubConnector({ fetch: cassettePlayer('github/pull.json') }),
    )

    const rows = await signalsIn(workspaceId)
    const deployment = rows.find((row) => row.kind === 'deployment')!
    // PROTO-3 matches a preview to a pull request by environment and commit, so
    // a deployment signal without those is a row it cannot use.
    expect(deployment.structured).toMatchObject({
      environment: 'preview',
      ref: 'fix/deploy-timeout',
      transient: true,
    })
    expect(String(deployment.structured.sha)).toHaveLength(40)

    const run = rows.find((row) => row.kind === 'workflow_run')!
    expect(run.structured).toMatchObject({ status: 'completed', conclusion: 'success' })
    expect(String(run.structured.headSha)).toHaveLength(40)
  })

  it('INT-2: timestamps come from GitHub, never from ingest time', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    await runner.sync(
      workspaceId,
      integrationId,
      createGitHubConnector({ fetch: cassettePlayer('github/pull.json') }),
    )

    for (const row of await signalsIn(workspaceId)) {
      // A signal stamped with its ingest time is misfiled forever and nothing
      // downstream can tell. The frozen clock makes that visible here.
      expect(row.occurred_at.toISOString(), row.external_id).not.toBe(frozen.toISOString())
      expect(row.occurred_at.getTime()).toBeLessThan(frozen.getTime())
    }
  })

  it('INT-2 AC3: a push delivery is ingested with the paths it changed', async () => {
    const { workspaceId, integrationId } = await connected()
    const receiver = createWebhookReceiver(db.config, store, { now: () => frozen })

    const outcome = await receiver.receive(
      workspaceId,
      integrationId,
      createGitHubConnector(),
      delivery('push-1', 'push', {
        ref: 'refs/heads/main',
        repository: { full_name: REPO, private: true },
        commits: [
          {
            id: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
            message: 'Fix the deploy timeout',
            timestamp: '2026-09-01T09:00:00Z',
            url: `https://github.com/${REPO}/commit/a1b2c3d`,
            author: { name: 'Ada Lovelace', email: 'ada@example.test' },
            added: ['src/retry.ts'],
            modified: ['src/deploy.ts'],
            removed: [],
          },
        ],
      }),
    )

    expect(outcome.state).toBe('processed')
    const [row] = await signalsIn(workspaceId)
    // The changed paths are captured at receipt so an incremental re-index needs
    // no second request, and so a replay of the delivery is self-contained.
    expect(row!.structured.changedPaths).toEqual(['src/retry.ts', 'src/deploy.ts'])
    expect(row!.structured.ref).toBe('refs/heads/main')
  })

  it('INT-2 AC3: a push and a later sync agree on what a commit is called', async () => {
    // If they disagreed, the same commit would be stored twice under two ids —
    // and which one survives would depend on the order they arrived in.
    const { workspaceId, integrationId } = await connected()
    const receiver = createWebhookReceiver(db.config, store, { now: () => frozen })
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    await receiver.receive(
      workspaceId,
      integrationId,
      createGitHubConnector(),
      delivery('push-2', 'push', {
        ref: 'refs/heads/main',
        repository: { full_name: REPO, private: true },
        commits: [
          {
            id: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
            message: 'Fix the deploy timeout',
            timestamp: '2026-09-01T09:00:00Z',
            url: `https://github.com/${REPO}/commit/a1b2c3d`,
            author: { name: 'Ada Lovelace', email: 'ada@example.test' },
            added: [],
            modified: ['src/deploy.ts'],
            removed: [],
          },
        ],
      }),
    )

    const outcome = await runner.sync(
      workspaceId,
      integrationId,
      createGitHubConnector({ fetch: cassettePlayer('github/pull.json') }),
    )

    const commits = (await signalsIn(workspaceId)).filter((row) => row.kind === 'commit')
    expect(commits.map((row) => row.external_id)).toEqual([
      `${REPO}@a1b2c3d4e5f60718293a4b5c6d7e8f9012345678`,
      `${REPO}@b2c3d4e5f60718293a4b5c6d7e8f901234567890`,
    ])
    expect(outcome.duplicates, 'the sync must recognise the pushed commit').toBeGreaterThan(0)
  })

  it('INT-2 AC4: a workflow_run delivery is ingested', async () => {
    const { workspaceId, integrationId } = await connected()
    const receiver = createWebhookReceiver(db.config, store, { now: () => frozen })

    const outcome = await receiver.receive(
      workspaceId,
      integrationId,
      createGitHubConnector(),
      delivery('run-1', 'workflow_run', {
        repository: { full_name: REPO, private: true },
        workflow_run: {
          id: 9501,
          name: 'CI',
          status: 'completed',
          conclusion: 'failure',
          event: 'pull_request',
          head_sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
          head_branch: 'fix/deploy-timeout',
          html_url: `https://github.com/${REPO}/actions/runs/9501`,
          created_at: '2026-09-01T11:05:00Z',
          updated_at: '2026-09-01T11:12:00Z',
          actor: { id: 501, login: 'ada' },
        },
      }),
    )

    expect(outcome.state).toBe('processed')
    const [row] = await signalsIn(workspaceId)
    expect(row!.kind).toBe('workflow_run')
    expect(row!.structured).toMatchObject({ conclusion: 'failure' })
  })

  it('INT-2: an event the connector does not map is accepted, not failed', async () => {
    // GitHub delivers whatever the installation subscribed to. Throwing on the
    // unfamiliar would fail deliveries we merely have no use for, and they
    // would then be retried forever.
    const { workspaceId, integrationId } = await connected()
    const receiver = createWebhookReceiver(db.config, store, { now: () => frozen })

    const outcome = await receiver.receive(
      workspaceId,
      integrationId,
      createGitHubConnector(),
      delivery('star-1', 'star', { repository: { full_name: REPO, private: true } }),
    )

    expect(outcome.state).toBe('processed')
    expect(outcome.ingested).toBe(0)
  })

  it('INT-2: a rate-limited sync backs off with the delay GitHub asked for', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    const outcome = await runner.sync(
      workspaceId,
      integrationId,
      createGitHubConnector({ fetch: cassettePlayer('github/rate-limited.json') }),
    )

    expect(outcome.state).toBe('rate_limited')
    // GitHub's own `retry-after`, honoured rather than guessed at.
    expect(outcome.retryAfterMs).toBe(60_000)
  })

  it('INT-2: a revoked installation is reported as needing a human', async () => {
    const { workspaceId, integrationId } = await connected()
    const runner = createSyncRunner(db.config, store, { now: () => frozen })

    await runner.sync(
      workspaceId,
      integrationId,
      createGitHubConnector({ fetch: cassettePlayer('github/credential-expired.json') }),
    )

    const [row] = await db.admin.query<{ status: string; health: Record<string, unknown> }>(
      `SELECT status, health FROM integrations WHERE id = $1`,
      [integrationId],
    )
    expect(row!.status).toBe('failed')
    expect(String(row!.health.lastError)).toMatch(/401/)
    expect(JSON.stringify(row!.health)).not.toContain('ghs_installation')
  })
})
