import pg from 'pg'
import type { Pool, PoolClient } from 'pg'

// `pg` is CommonJS and builds its exports dynamically, which defeats Node's
// static named-export detection. A named *value* import works under a bundler —
// so every test passes — and fails only when the real process starts, which is
// the worst place to find out. Destructuring the default works in both.
//
// The type is still imported by name: `import type` is erased, so it never
// reaches the runtime resolution that is the problem.
const { Pool: PgPool } = pg
import { ConfigurationError } from '@chorus/core'

/**
 * The only way to reach the database (ADR-0003).
 *
 * Every tenant query runs inside a transaction that has set `app.workspace_id`,
 * which is what the row-level security policies bind to. The application role
 * has no BYPASSRLS, so a query issued outside this accessor sees nothing rather
 * than everything — the isolation fails closed.
 *
 * A lint rule forbids importing a driver anywhere but this package
 * (test/nfr/boundaries.test.ts), so this really is the only door.
 */

export interface DbConfig {
  readonly host: string
  readonly port: number
  readonly database: string
  /** The unprivileged application role. Must not be a superuser. */
  readonly appUser: string
  readonly appPassword: string
  /** The migration owner. Separate from the application role by design. */
  readonly ownerUser: string
  readonly ownerPassword: string
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const host = env.CHORUS_DB_HOST ?? '127.0.0.1'
  const port = Number(env.CHORUS_DB_PORT ?? 5432)
  const database = env.CHORUS_DB_NAME ?? 'chorus'
  const ownerUser = env.CHORUS_DB_USER ?? 'chorus'
  const ownerPassword = env.CHORUS_DB_PASSWORD ?? 'chorus'

  if (Number.isNaN(port)) {
    throw new ConfigurationError('CHORUS_DB_PORT must be a number', { value: env.CHORUS_DB_PORT })
  }

  return {
    host,
    port,
    database,
    ownerUser,
    ownerPassword,
    appUser: env.CHORUS_DB_APP_USER ?? 'chorus_app',
    appPassword: env.CHORUS_DB_APP_PASSWORD ?? 'chorus_app',
  }
}

/**
 * Pools are keyed by the connection they describe. Caching a single pool and
 * ignoring later configs would silently hand back a connection to the wrong
 * database -- which is exactly what an isolated-database test needs not to
 * happen.
 */
const appPools = new Map<string, Pool>()

/**
 * Every pool in the system is created here.
 *
 * Two earlier defects came from pools created elsewhere: one missed its
 * idle-error handler and failed CI on a dropped test database, and a later pair
 * were never closed at teardown and did the same. Patching each site invites the
 * same fault the next time a pool is needed, so pool creation is centralised and
 * every pool is both handled and tracked. Closing is then total by construction.
 */
const managedPools = new Set<Pool>()

/**
 * Pools are cached by identity, because construction is not free.
 *
 * `createApp` builds an auth pool, a token-ledger pool and an event-log pool,
 * and a test suite builds an app per test. Uncached, that is three new pools
 * per test, each holding up to five connections, against a server that permits
 * a hundred. The result was not an error anyone could read: requests were
 * dropped sporadically under load and surfaced as a missing audit row or an
 * unsent email in whichever unrelated suite happened to be running. Caching by
 * identity makes the count a function of how many databases are in play rather
 * than of how many tests have run.
 */
const managedByKey = new Map<string, Pool>()

export function createManagedPool(options: {
  host: string
  port: number
  database: string
  user: string
  password: string
  max?: number
  label: string
}): Pool {
  // The label is part of the key: two pools with different purposes and
  // different sizes against the same database are deliberately distinct.
  const key = `${options.label}:${options.user}@${options.host}:${options.port}/${options.database}`
  const existing = managedByKey.get(key)
  if (existing) return existing

  const pool = new PgPool({
    host: options.host,
    port: options.port,
    database: options.database,
    user: options.user,
    password: options.password,
    max: options.max ?? 10,
  })
  // An idle client whose backend is terminated -- a dropped test database, a
  // failover -- emits on its pool. Unhandled, that becomes an unhandled
  // rejection and fails a run in which every test passed.
  pool.on('error', (error) => {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: `idle database client error (${options.label})`,
        error: String(error),
      }),
    )
  })
  managedPools.add(pool)
  managedByKey.set(key, pool)
  return pool
}

function poolKey(config: DbConfig): string {
  return `${config.host}:${config.port}/${config.database}@${config.appUser}`
}

function getAppPool(config: DbConfig = configFromEnv()): Pool {
  const key = poolKey(config)
  let pool = appPools.get(key)
  if (!pool) {
    pool = createManagedPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.appUser,
      password: config.appPassword,
      label: 'app',
    })
    appPools.set(key, pool)
  }
  return pool
}

export interface TenantTx {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  /** Returns the number of rows affected. */
  execute(sql: string, params?: unknown[]): Promise<number>
}

/**
 * Run `fn` inside a transaction scoped to one workspace.
 *
 * `SET LOCAL` confines the setting to the transaction, so a pooled connection
 * cannot leak one workspace's context into the next caller's query — which
 * would be a cross-tenant read with no code change to blame.
 */
export async function withTenant<T>(
  workspaceId: string,
  fn: (tx: TenantTx) => Promise<T>,
  options: {
    userId?: string
    config?: DbConfig
    /**
     * Additional `SET LOCAL` values the row-level security policies read.
     * Confined to the transaction like the tenant id, so nothing leaks into
     * the next caller on a pooled connection.
     */
    settings?: Readonly<Record<string, string>>
  } = {},
): Promise<T> {
  const client = await getAppPool(options.config).connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', workspaceId])
    if (options.userId) {
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', options.userId])
    }
    for (const [name, value] of Object.entries(options.settings ?? {})) {
      await client.query('SELECT set_config($1, $2, true)', [name, value])
    }

    const result = await fn(wrapClient(client))
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      /* the original error is the one worth reporting */
    })
    throw error
  } finally {
    client.release()
  }
}

function wrapClient(client: PoolClient): TenantTx {
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await client.query(sql, params)
      return result.rows as T[]
    },
    async execute(sql: string, params: unknown[] = []): Promise<number> {
      const result = await client.query(sql, params)
      return result.rowCount ?? 0
    },
  }
}

/**
 * Close every managed pool. Tests and shutdown hooks call this.
 *
 * Total by construction: anything from createManagedPool is closed here, so a
 * new pool cannot be forgotten at teardown.
 */
export async function closePool(): Promise<void> {
  const pools = [...managedPools]
  managedPools.clear()
  managedByKey.clear()
  appPools.clear()
  await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)))
}
