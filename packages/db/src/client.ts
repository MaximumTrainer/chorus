import { Pool, type PoolClient } from 'pg'
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

function poolKey(config: DbConfig): string {
  return `${config.host}:${config.port}/${config.database}@${config.appUser}`
}

function getAppPool(config: DbConfig = configFromEnv()): Pool {
  const key = poolKey(config)
  let pool = appPools.get(key)
  if (!pool) {
    pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.appUser,
      password: config.appPassword,
      max: 10,
    })
    // An idle client whose backend is terminated (a dropped test database, a
    // failover) emits on the pool. Without a handler that becomes an
    // unhandled rejection and fails an otherwise-passing run.
    pool.on('error', (error) => {
      console.warn(
        JSON.stringify({ level: 'warn', message: 'idle database client error', error: String(error) }),
      )
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
  options: { userId?: string; config?: DbConfig } = {},
): Promise<T> {
  const client = await getAppPool(options.config).connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', workspaceId])
    if (options.userId) {
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', options.userId])
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

/** Close every pool. Tests and shutdown hooks call this. */
export async function closePool(): Promise<void> {
  const pools = [...appPools.values()]
  appPools.clear()
  await Promise.all(pools.map((pool) => pool.end()))
}
