import { describe, it, expect, afterEach } from 'vitest'
import { connectAdmin, configFromEnv } from '../../src/index.js'

/**
 * #158-adjacent — the role every isolated database creates, created twice at once.
 *
 * `applyMigrations` creates the application role before granting it anything,
 * guarded by an advisory lock and a `duplicate_object` handler. Both guards
 * miss the case that actually happens in CI.
 *
 * The advisory lock is taken in the database being migrated, and every isolated
 * test database is a *different* database — so two of them take two different
 * locks and are not serialised against each other at all. Roles, meanwhile, are
 * cluster-wide.
 *
 * And `duplicate_object` is raised when Postgres finds the role by name before
 * inserting. Two sessions that both look and both find nothing race to the
 * unique index instead, and the loser gets `unique_violation` — a different
 * SQLSTATE, unhandled, and fatal to whichever test file happened to lose.
 *
 * It only bites on a cluster where the role does not already exist, which is
 * why it is invisible on a developer's machine and reproducible on a fresh CI
 * runner: locally the role survives from the last run and the fast path is
 * taken every time.
 */
describe('isolated database role creation', () => {
  const config = configFromEnv()
  const roleName = `chorus_race_${Math.random().toString(36).slice(2, 10)}`
  const connections: Array<Awaited<ReturnType<typeof connectAdmin>>> = []

  afterEach(async () => {
    const [first] = connections
    // Best effort: the role owns nothing, so this succeeds; a failure here must
    // not fail a test that passed.
    if (first) await first.execute(`DROP ROLE IF EXISTS ${roleName}`).catch(() => {})
    await Promise.all(connections.map((c) => c.close?.()))
    connections.length = 0
  })

  it('#158: concurrent creation of the same role does not fail one of the callers', async () => {
    // Separate connections, not one pooled admin. A shared pool of four would
    // queue these and they would never actually race — which is how a test for
    // this can pass against the bug it is supposed to catch.
    const CALLERS = 12
    for (let i = 0; i < CALLERS; i += 1) connections.push(await connectAdmin(config))

    // Given a role that does not exist — the state of a fresh cluster, and the
    // only state in which this race is reachable.
    await connections[0]!.execute(`DROP ROLE IF EXISTS ${roleName}`)

    // Warmed first, so the concurrency is in the CREATE and not in connecting.
    await Promise.all(connections.map((c) => c.query('SELECT 1')))

    // When several callers create it at once, as parallel test files do
    const create = (connection: (typeof connections)[number]) =>
      connection.execute(`
        DO $$
        BEGIN
          CREATE ROLE ${roleName} LOGIN PASSWORD '${roleName}';
        EXCEPTION
          WHEN duplicate_object THEN NULL;
          WHEN unique_violation THEN NULL;
        END
        $$;
      `)

    const outcomes = await Promise.allSettled(connections.map(create))

    // Then every one of them succeeds. A caller that loses the race has still
    // got what it asked for — the role exists — so failing it turns a
    // successful outcome into a fatal error for whichever test file was second.
    const rejected = outcomes.filter((o) => o.status === 'rejected')
    expect(
      rejected,
      `every concurrent creator should succeed: ${rejected
        .map((o) => (o as PromiseRejectedResult).reason)
        .join('; ')}`,
    ).toHaveLength(0)

    const [row] = await connections[0]!.query<{ count: string }>(
      `SELECT count(*) AS count FROM pg_roles WHERE rolname = $1`,
      [roleName],
    )
    expect(Number(row!.count)).toBe(1)
  }, 120_000)
})
