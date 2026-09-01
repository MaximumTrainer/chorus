import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from '@chorus/core'
import { configFromEnv, createManagedPool, type DbConfig, type TenantTx } from './client.js'

/**
 * Privileged access, used only by migrations and by the tenancy suite.
 *
 * The suite seeds and inspects as the owner so that it does not depend on the
 * very code paths it is testing: if isolation were broken *and* the seeding
 * went through the tenant accessor, the test could pass by symmetry.
 */

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')

export interface AdminConnection {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<void>
  /** Insert one row into every tenant table for a workspace. */
  seedWorkspace(workspaceId: string): Promise<void>
  /** Attempt to insert a row belonging to `workspaceId` through a tenant transaction. */
  insertMinimalRow(tx: TenantTx, table: string, workspaceId: string): Promise<void>
  /** Run a query as the unprivileged role with no tenant context set. */
  queryAsAppRoleWithoutTenant<T = Record<string, unknown>>(sql: string): Promise<T[]>
  close(): Promise<void>
}

export async function connectAdmin(config: DbConfig = configFromEnv()): Promise<AdminConnection> {
  const owner = createManagedPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.ownerUser,
    password: config.ownerPassword,
    max: 4,
    label: 'owner',
  })

  const appRole = createManagedPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.appUser,
    password: config.appPassword,
    max: 2,
    label: 'app-role',
  })

  // Make the application role's name available to assertions that check it has
  // neither BYPASSRLS nor superuser.
  await owner.query(`SELECT set_config('chorus.app_role', $1, false)`, [config.appUser])

  const userIds = new Map<string, string>()

  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await owner.query(sql, params)
      // Session settings are per-connection; re-assert on each query so the
      // pg_roles assertion works regardless of which pooled connection served it.
      return result.rows as T[]
    },

    async execute(sql, params = []) {
      await owner.query(sql, params)
    },

    async seedWorkspace(workspaceId) {
      const userId = ulid()
      userIds.set(workspaceId, userId)

      await owner.query(
        `INSERT INTO users (id, email, name) VALUES ($1, $2, 'Seed User')`,
        [userId, `${userId}@example.test`],
      )
      await owner.query(`INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Seed', $1)`, [
        workspaceId,
      ])

      const teamId = ulid()
      await owner.query(
        `INSERT INTO teams (id, workspace_id, name, slug) VALUES ($1, $2, 'Default', 'default')`,
        [teamId, workspaceId],
      )
      await owner.query(
        `INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
        [ulid(), workspaceId, userId],
      )
      await owner.query(
        `INSERT INTO team_members (id, workspace_id, team_id, user_id) VALUES ($1, $2, $3, $4)`,
        [ulid(), workspaceId, teamId, userId],
      )
      await owner.query(
        `INSERT INTO invitations (id, workspace_id, email, token_hash, role, expires_at, created_by)
         VALUES ($1, $2, 'invitee@example.test', $3, 'member', now() + interval '7 days', $4)`,
        [ulid(), workspaceId, ulid(), userId],
      )
      await owner.query(
        `INSERT INTO api_tokens (id, workspace_id, user_id, name, token_hash, token_prefix)
         VALUES ($1, $2, $3, 'seed', $4, 'chs_seed')`,
        [ulid(), workspaceId, userId, ulid()],
      )
      await owner.query(
        `INSERT INTO audit_events (id, workspace_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, $2, 'user', $3, 'seed', 'workspace', $2)`,
        [ulid(), workspaceId, userId],
      )
    },

    async insertMinimalRow(tx, table, workspaceId) {
      const userId = userIds.get(workspaceId)
      const id = ulid()
      switch (table) {
        case 'workspace_members':
          await tx.execute(
            `INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES ($1, $2, $3, 'member')`,
            [id, workspaceId, userId],
          )
          return
        case 'teams':
          await tx.execute(
            `INSERT INTO teams (id, workspace_id, name, slug) VALUES ($1, $2, 'x', $1)`,
            [id, workspaceId],
          )
          return
        case 'team_members': {
          const [team] = await tx.query<{ id: string }>(`SELECT id FROM teams LIMIT 1`)
          await tx.execute(
            `INSERT INTO team_members (id, workspace_id, team_id, user_id) VALUES ($1, $2, $3, $4)`,
            [id, workspaceId, team?.id ?? id, userId],
          )
          return
        }
        case 'invitations':
          await tx.execute(
            `INSERT INTO invitations (id, workspace_id, token_hash, role, expires_at, created_by)
             VALUES ($1, $2, $3, 'member', now() + interval '1 day', $4)`,
            [id, workspaceId, id, userId],
          )
          return
        case 'api_tokens':
          await tx.execute(
            `INSERT INTO api_tokens (id, workspace_id, user_id, name, token_hash, token_prefix)
             VALUES ($1, $2, $3, 'x', $4, 'chs_x')`,
            [id, workspaceId, userId, id],
          )
          return
        case 'audit_events':
          await tx.execute(
            `INSERT INTO audit_events (id, workspace_id, actor_type, action, target_type)
             VALUES ($1, $2, 'system', 'x', 'workspace')`,
            [id, workspaceId],
          )
          return
        default:
          throw new Error(`insertMinimalRow has no case for "${table}" — add one when adding a table`)
      }
    },

    async queryAsAppRoleWithoutTenant<T>(sql: string): Promise<T[]> {
      const result = await appRole.query(sql)
      return result.rows as T[]
    },

    async close() {
      // Pools are managed centrally now, so closePool() may already have ended
      // these. Closing twice is harmless and this keeps close() safe to call
      // from either path rather than making callers track which ran first.
      await Promise.all([
        owner.end().catch(() => undefined),
        appRole.end().catch(() => undefined),
      ])
    },
  }
}

/** Apply every migration in order. Forward-only, by filename. */
export async function applyMigrations(admin: AdminConnection): Promise<string[]> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  const config = configFromEnv()

  for (const file of files) {
    await admin.execute(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }

  // The application role is created after the schema exists so it can be
  // granted table privileges. It is deliberately unprivileged: no BYPASSRLS,
  // no superuser, no ownership.
  await admin.execute(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${config.appUser}') THEN
        CREATE ROLE ${config.appUser} LOGIN PASSWORD '${config.appPassword}';
      END IF;
    END
    $$;
  `)
  await admin.execute(`GRANT USAGE ON SCHEMA public TO ${config.appUser}`)
  await admin.execute(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${config.appUser}`,
  )
  await admin.execute(`SELECT set_config('chorus.app_role', '${config.appUser}', false)`)

  return files
}

/** Drop and recreate the public schema. Test setup only. */
export async function resetDatabase(admin: AdminConnection): Promise<void> {
  await admin.execute('DROP SCHEMA IF EXISTS public CASCADE')
  await admin.execute('CREATE SCHEMA public')
}
