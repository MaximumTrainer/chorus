import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { LimitExceededError, UpstreamError, type GitHost, type GitHostCommit } from '@chorus/core'
import { ulid, type EntityCandidate } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createEntityStore, createWikiCompiler, createWikiPublisher } from '../../src/index.js'

/**
 * BRAIN-5 — committing the compiled wiki to git.
 *
 * Pages are committed under the bot identity with a message naming what
 * changed (AC6); only changed pages are committed, not the whole repository
 * (AC3); a failed push retries with backoff and leaves nothing half-committed,
 * so a crash re-commits rather than losing work (AC5).
 */

/** A scriptable in-memory git host: records commits, and can fail the first N. */
function fakeGit(options: { failFirst?: number; failWith?: 'retryable' | 'quota' } = {}): GitHost & {
  readonly commits: Array<{ message: string; authorName: string; authorEmail: string }>
} {
  const commits: Array<{ message: string; authorName: string; authorEmail: string }> = []
  let fails = options.failFirst ?? 0
  return {
    commits,
    async createBranch(_r, branch) {
      return { name: branch, baseSha: 'base' }
    },
    async commit(o): Promise<GitHostCommit> {
      if (fails > 0) {
        fails -= 1
        throw options.failWith === 'quota'
          ? new LimitExceededError('spend ceiling hit')
          : new UpstreamError('remote unavailable')
      }
      commits.push({ message: o.message, authorName: o.authorName, authorEmail: o.authorEmail })
      return { sha: `sha-${commits.length}`, message: o.message }
    },
    async openPullRequest() {
      throw new Error('not used')
    },
  }
}

describe('BRAIN-5 wiki publishing', () => {
  let db: IsolatedDatabase
  const bot = { name: 'Chorus Brain', email: 'brain@chorus.test' }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  async function compiledWorkspace(): Promise<string> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM wiki_pages WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM entities WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM signals WHERE workspace_id = $1`, [workspaceId])
    const [integration] = await db.admin.query<{ id: string }>(
      `SELECT id FROM integrations WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    const store = createEntityStore(db.config)
    const entity = (externalId: string, name: string): EntityCandidate => ({
      kind: 'feature',
      externalId,
      name,
      aliases: [],
      attributes: {},
      evidence: { signalExternalId: 'sig', source: 'linear' },
    })
    for (let i = 0; i < 2; i += 1) {
      const id = ulid()
      await db.admin.execute(
        `INSERT INTO signals (id, workspace_id, integration_id, source, external_id, kind, text, occurred_at, permissions)
         VALUES ($1, $2, $3, 'linear', $1, 'issue', 'a claim', now(), '{"visibility":"public","scopeIds":[]}'::jsonb)`,
        [id, workspaceId, integration!.id],
      )
      await store.upsertCandidate({ workspaceId, candidate: entity('e:billing', 'Billing Service'), signalId: id, extractorVersion: 1 })
    }
    await createWikiCompiler(db.config).compile(workspaceId)
    return workspaceId
  }

  it('BRAIN-5 AC6: commits changed pages under the bot identity with a descriptive message', async () => {
    const workspaceId = await compiledWorkspace()
    const git = fakeGit()
    const result = await createWikiPublisher({
      config: db.config,
      gitHost: git,
      repositoryFullName: 'acme/product-brain',
      bot,
    }).publish(workspaceId)

    expect(result.state).toBe('committed')
    expect(result.committed).toBeGreaterThanOrEqual(1)
    expect(git.commits).toHaveLength(1)
    expect(git.commits[0]).toMatchObject({ authorName: bot.name, authorEmail: bot.email })
    expect(git.commits[0]!.message).toMatch(/wiki/i)
  })

  it('BRAIN-5 AC3: a second publish with nothing changed commits nothing', async () => {
    const workspaceId = await compiledWorkspace()
    const git = fakeGit()
    const publisher = createWikiPublisher({ config: db.config, gitHost: git, repositoryFullName: 'acme/product-brain', bot })

    await publisher.publish(workspaceId)
    const second = await publisher.publish(workspaceId)
    expect(second.state).toBe('nothing_to_commit')
    expect(git.commits).toHaveLength(1)
  })

  it('BRAIN-5 AC5: a retryable push failure is retried, then succeeds, with no partial state', async () => {
    const workspaceId = await compiledWorkspace()
    const git = fakeGit({ failFirst: 1, failWith: 'retryable' })
    const attempts: number[] = []
    const result = await createWikiPublisher({
      config: db.config,
      gitHost: git,
      repositoryFullName: 'acme/product-brain',
      bot,
      backoff: async (n) => {
        attempts.push(n)
      },
    }).publish(workspaceId)

    expect(result.state).toBe('committed')
    expect(attempts).toEqual([1]) // backed off once before the retry
    expect(git.commits).toHaveLength(1)

    // The pages are marked published only after success — a retry of a clean
    // state now commits nothing.
    const again = await createWikiPublisher({ config: db.config, gitHost: fakeGit(), repositoryFullName: 'acme/product-brain', bot }).publish(workspaceId)
    expect(again.state).toBe('nothing_to_commit')
  })

  it('BRAIN-5 AC5: a non-retryable failure (quota) stops without committing or publishing', async () => {
    const workspaceId = await compiledWorkspace()
    const git = fakeGit({ failFirst: 9, failWith: 'quota' })
    const result = await createWikiPublisher({ config: db.config, gitHost: git, repositoryFullName: 'acme/product-brain', bot }).publish(workspaceId)

    expect(result.state).toBe('failed')
    expect(git.commits).toHaveLength(0)
    // Nothing marked published, so the next run still has the pages to commit.
    const retry = await createWikiPublisher({ config: db.config, gitHost: fakeGit(), repositoryFullName: 'acme/product-brain', bot }).publish(workspaceId)
    expect(retry.state).toBe('committed')
  })
})
