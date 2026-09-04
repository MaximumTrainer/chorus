import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid } from '@chorus/core'
import { createFakeModelProvider, type FakeModelProvider } from '@chorus/testing'
import { createRetriever, type Retriever } from '../../src/index.js'

/**
 * BRAIN-4 — one retrieval function, used by everything.
 *
 * > Retrieval is the single point where grounding quality and privacy are both
 * > decided.
 *
 * Both halves are tested here, and the privacy half is the one with teeth. The
 * requirement is explicit that filtering happens **in the query**: a predicate
 * applied to results afterwards silently reduces counts and leaks through
 * relevance scores, so the tests below check not only that forbidden content is
 * absent but that its absence did not change what the caller was told about the
 * results they did get.
 */
describe('BRAIN-4 retrieval', () => {
  let db: IsolatedDatabase
  let models: FakeModelProvider
  let retriever: Retriever

  interface World {
    workspaceId: string
    /** Belongs to the team that owns `repoId`. */
    insiderId: string
    /** A workspace member, but not of that team. */
    outsiderId: string
    teamId: string
    repoId: string
  }

  /** Two teams, two repositories, one member of each. */
  async function world(): Promise<World> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)

    const [owner] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    const [team] = await db.admin.query<{ id: string }>(
      `SELECT id FROM teams WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    const [repo] = await db.admin.query<{ id: string }>(
      `SELECT id FROM repositories WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )

    // A second person who is in the workspace but not in the team that owns the
    // repository. This is the shape the permission predicate exists for.
    const outsiderId = ulid()
    await db.admin.execute(
      `INSERT INTO users (id, email, name, email_verified)
       VALUES ($1, $2, 'Outsider', true)`,
      [outsiderId, `outsider-${outsiderId}@example.test`],
    )
    await db.admin.execute(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, 'member')`,
      [ulid(), workspaceId, outsiderId],
    )

    await db.admin.execute(`DELETE FROM code_chunks WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM code_files WHERE workspace_id = $1`, [workspaceId])

    return {
      workspaceId,
      insiderId: owner!.user_id,
      outsiderId,
      teamId: team!.id,
      repoId: repo!.id,
    }
  }

  /** Adds one file with one chunk, embedded the way the fake provider embeds. */
  async function addChunk(
    w: World,
    input: { path: string; text: string; repoId?: string; symbol?: string },
  ): Promise<string> {
    const fileId = ulid()
    await db.admin.execute(
      `INSERT INTO code_files (id, workspace_id, repository_id, path, lang, content_hash)
       VALUES ($1, $2, $3, $4, 'ts', $5)`,
      [fileId, w.workspaceId, input.repoId ?? w.repoId, input.path, ulid()],
    )

    const chunkId = ulid()
    await db.admin.execute(
      `INSERT INTO code_chunks
         (id, workspace_id, repository_id, file_id, text, line_start, line_end, symbol_name, embedding)
       VALUES ($1, $2, $3, $4, $5, 1, 10, $6, $7::vector)`,
      [
        chunkId,
        w.workspaceId,
        input.repoId ?? w.repoId,
        fileId,
        input.text,
        input.symbol ?? null,
        `[${models.embedText(input.text).join(',')}]`,
      ],
    )
    return chunkId
  }

  /** A second repository, owned by a team the outsider is not in either. */
  async function otherTeamRepo(w: World): Promise<string> {
    const teamId = ulid()
    await db.admin.execute(
      `INSERT INTO teams (id, workspace_id, name, slug) VALUES ($1, $2, 'Other', $3)`,
      [teamId, w.workspaceId, `other-${teamId.slice(-6).toLowerCase()}`],
    )
    const [integration] = await db.admin.query<{ id: string }>(
      `SELECT id FROM integrations WHERE workspace_id = $1 LIMIT 1`,
      [w.workspaceId],
    )
    const repoId = ulid()
    await db.admin.execute(
      `INSERT INTO repositories
         (id, workspace_id, team_id, integration_id, provider, full_name)
       VALUES ($1, $2, $3, $4, 'github', $5)`,
      [repoId, w.workspaceId, teamId, integration!.id, `acme/secret-${repoId.slice(-6)}`],
    )
    return repoId
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    models = createFakeModelProvider()
    retriever = createRetriever(db.config, { models, embeddingModel: { provider: 'fake', model: 'fake-embed' } })
  })

  it('BRAIN-4 AC2: content in a team the caller is not in is absent', async () => {
    const w = await world()
    const otherRepo = await otherTeamRepo(w)

    await addChunk(w, { path: 'src/open.ts', text: 'export function parseInvoice(line: string) {}' })
    await addChunk(w, {
      path: 'src/secret.ts',
      text: 'export function parseInvoice(line: string) { /* restricted */ }',
      repoId: otherRepo,
    })

    // The insider is in the first team only, so exactly one of the two is
    // theirs — and both match the query equally well, so a filter that did not
    // work would be obvious.
    const bundle = await retriever.retrieve({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      userId: w.insiderId,
      query: 'parseInvoice',
    })

    expect(bundle.fragments).toHaveLength(1)
    expect(bundle.fragments[0]!.path).toBe('src/open.ts')
  })

  it('BRAIN-4 AC2: a member of no team retrieves nothing, not everything', async () => {
    const w = await world()
    await addChunk(w, { path: 'src/open.ts', text: 'export function parseInvoice() {}' })

    // The failure mode a post-hoc filter has: an empty membership set becomes
    // an unconstrained query rather than an empty result.
    const bundle = await retriever.retrieve({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      userId: w.outsiderId,
      query: 'parseInvoice',
    })

    expect(bundle.fragments).toEqual([])
  })

  it('BRAIN-4 AC2: the filter is in the query, so counts do not leak what was hidden', async () => {
    const w = await world()
    const otherRepo = await otherTeamRepo(w)

    await addChunk(w, { path: 'src/open.ts', text: 'the shared term appears here' })
    for (let i = 0; i < 5; i += 1) {
      await addChunk(w, {
        path: `src/hidden-${i}.ts`,
        text: 'the shared term appears here too',
        repoId: otherRepo,
      })
    }

    const bundle = await retriever.retrieve({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      userId: w.insiderId,
      query: 'the shared term',
      k: 10,
    })

    // Post-filtering would have taken the top 10, thrown five away, and
    // returned one — indistinguishable here. What gives it away is `considered`:
    // a caller asking for 10 must not learn that five more existed.
    expect(bundle.fragments).toHaveLength(1)
    expect(bundle.considered, 'the search itself must never have seen them').toBe(1)
  })

  it('BRAIN-4 AC1: an exact term is found even when its wording is unusual', async () => {
    const w = await world()
    await addChunk(w, { path: 'src/a.ts', text: 'function reconcileLedgerEntries() {}' })
    await addChunk(w, { path: 'src/b.ts', text: 'a function about invoices and money' })

    // The lexical half's job. A vector-only search on a rare identifier is a
    // coin toss, because an embedding of a name it has never seen is noise.
    const bundle = await retriever.retrieve({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      userId: w.insiderId,
      query: 'reconcileLedgerEntries',
    })

    expect(bundle.fragments[0]!.path).toBe('src/a.ts')
  })

  it('BRAIN-4 AC1: a paraphrase finds the right chunk without sharing its words', async () => {
    const w = await world()
    await addChunk(w, { path: 'src/auth.ts', text: 'validate the session cookie and reject expired tokens' })
    await addChunk(w, { path: 'src/csv.ts', text: 'parse comma separated values into rows' })

    // The vector half's job, and the fake provider's embedding is word-overlap
    // based, so "session cookie" reaches the auth chunk and not the CSV one.
    const bundle = await retriever.retrieve({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      userId: w.insiderId,
      query: 'session cookie expired',
    })

    expect(bundle.fragments[0]!.path).toBe('src/auth.ts')
  })

  it('BRAIN-4 AC6: nothing matching returns nothing, not the least-bad thing', async () => {
    const w = await world()
    await addChunk(w, { path: 'src/a.ts', text: 'export function parseInvoice() {}' })

    const bundle = await retriever.retrieve({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      userId: w.insiderId,
      query: 'quantum chromodynamics lattice gauge',
    })

    // "No low-relevance filler is included to appear helpful." A bundle padded
    // with the nearest vectors is how an agent comes to cite something
    // irrelevant with total confidence.
    expect(bundle.fragments).toEqual([])
    expect(bundle.considered).toBe(0)
  })

  it('BRAIN-4 AC4: a bundle can be stored and read back to the same fragments', async () => {
    const w = await world()
    await addChunk(w, { path: 'src/a.ts', text: 'export function parseInvoice() {}' })

    const bundle = await retriever.retrieve({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      userId: w.insiderId,
      query: 'parseInvoice',
    })
    await retriever.persist(w.workspaceId, bundle)

    const reloaded = await retriever.load(w.workspaceId, bundle.id)
    expect(reloaded).toBeDefined()
    // The same citations, resolving to the same fragments. This is what makes
    // a "Context used" panel exact rather than reconstructed (CHAT-3).
    expect(reloaded!.fragments.map((f) => f.citationId)).toEqual(
      bundle.fragments.map((f) => f.citationId),
    )
    expect(reloaded!.fragments[0]!.text).toBe(bundle.fragments[0]!.text)
  })

  it('BRAIN-4 AC4: a citation id is stable across identical retrievals', async () => {
    const w = await world()
    await addChunk(w, { path: 'src/a.ts', text: 'export function parseInvoice() {}' })

    const query = {
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      userId: w.insiderId,
      query: 'parseInvoice',
    }
    const first = await retriever.retrieve(query)
    const second = await retriever.retrieve(query)

    // Derived from what is cited, not from when it was cited. A citation id
    // that changed per retrieval would make two bundles of the same fragment
    // impossible to compare, which the evaluation harness needs to do.
    expect(second.fragments[0]!.citationId).toBe(first.fragments[0]!.citationId)
    expect(second.id).not.toBe(first.id)
  })

  it('BRAIN-4: every fragment carries enough to open it', async () => {
    const w = await world()
    await addChunk(w, {
      path: 'src/billing/invoice.ts',
      text: 'export function parseInvoice() {}',
      symbol: 'parseInvoice',
    })

    const bundle = await retriever.retrieve({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      userId: w.insiderId,
      query: 'parseInvoice',
    })

    // A citation somebody cannot follow is a claim, not a citation.
    expect(bundle.fragments[0]).toMatchObject({
      kind: 'code',
      path: 'src/billing/invoice.ts',
      lineStart: 1,
      lineEnd: 10,
      symbolName: 'parseInvoice',
    })
    expect(bundle.fragments[0]!.score).toBeGreaterThan(0)
  })

  it('BRAIN-4: a partial identifier finds the symbol that contains it', async () => {
    const w = await world()
    await addChunk(w, {
      path: 'src/a.ts',
      text: 'const total = lines.reduce(sum)',
      symbol: 'parseInvoiceLine',
    })

    // `parseInvoiceLine` is one token to the text search and three words to the
    // person searching. This is why the trigram index on `symbol_name` exists:
    // without it, searching for "invoice" finds nothing at all.
    const bundle = await retriever.retrieve({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      userId: w.insiderId,
      query: 'invoice',
    })

    expect(bundle.fragments[0]!.symbolName).toBe('parseInvoiceLine')
  })

  it('BRAIN-4: k truncates, and the bundle says how many it looked at', async () => {
    const w = await world()
    for (let i = 0; i < 8; i += 1) {
      await addChunk(w, {
        path: `src/f${i}.ts`,
        text: `export function handler${i}() { return parseInvoice(line) }`,
      })
    }

    const bundle = await retriever.retrieve({
      workspaceId: w.workspaceId,
      teamId: w.teamId,
      userId: w.insiderId,
      query: 'parseInvoice',
      k: 3,
    })

    expect(bundle.fragments).toHaveLength(3)
    // Distinct from the count returned: how many candidates the caller was
    // permitted to see, which is what makes "there is more" honest.
    expect(bundle.considered).toBeGreaterThan(3)
  })
})
