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
        `INSERT INTO policies (id, workspace_id, team_id, checkpoint_kind, mode)
         VALUES ($1, $2, $3, 'before_external_write', 'ask')`,
        [ulid(), workspaceId, teamId],
      )
      const clientId = ulid()
      await owner.query(
        `INSERT INTO oauth_clients (id, client_name, redirect_uris)
         VALUES ($1, 'Seed Client', ARRAY['http://localhost/callback'])`,
        [clientId],
      )
      const grantId = ulid()
      await owner.query(
        `INSERT INTO oauth_grants (id, workspace_id, client_id, user_id, scopes)
         VALUES ($1, $2, $3, $4, ARRAY['read:artefacts'])`,
        [grantId, workspaceId, clientId, userId],
      )
      await owner.query(
        `INSERT INTO oauth_tokens (id, workspace_id, grant_id, kind, token_hash, expires_at)
         VALUES ($1, $2, $3, 'access', $4, now() + interval '1 hour')`,
        [ulid(), workspaceId, grantId, ulid()],
      )
      await owner.query(
        `INSERT INTO workspace_data_keys (id, workspace_id, wrapped_key) VALUES ($1, $2, $3)`,
        [ulid(), workspaceId, `v1.seed.${ulid()}.${ulid()}.${ulid()}`],
      )
      const integrationId = ulid()
      await owner.query(
        `INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'reference')`,
        [integrationId, workspaceId],
      )
      await owner.query(
        `INSERT INTO signals
           (id, workspace_id, integration_id, source, external_id, kind, occurred_at, permissions)
         VALUES ($1, $2, $3, 'reference', $1, 'message', now(), '{"visibility":"public","scopeIds":[]}'::jsonb)`,
        [ulid(), workspaceId, integrationId],
      )
      const repositoryId = ulid()
      const fileId = ulid()
      await owner.query(
        `INSERT INTO repositories (id, workspace_id, team_id, integration_id, provider, full_name)
         VALUES ($1, $2, $3, $4, 'github', $1)`,
        [repositoryId, workspaceId, teamId, integrationId],
      )
      await owner.query(
        `INSERT INTO repo_index_runs (id, workspace_id, repository_id, status, commit_sha)
         VALUES ($1, $2, $3, 'succeeded', 'seedcommit')`,
        [ulid(), workspaceId, repositoryId],
      )
      await owner.query(
        `INSERT INTO code_files (id, workspace_id, repository_id, path, lang, content_hash)
         VALUES ($1, $2, $3, 'src/seed.ts', 'typescript', $1)`,
        [fileId, workspaceId, repositoryId],
      )
      await owner.query(
        `INSERT INTO code_symbols (id, workspace_id, file_id, kind, name, line_start, line_end)
         VALUES ($1, $2, $3, 'function', 'seed', 1, 2)`,
        [ulid(), workspaceId, fileId],
      )
      await owner.query(
        `INSERT INTO code_imports (id, workspace_id, file_id, specifier)
         VALUES ($1, $2, $3, 'node:fs')`,
        [ulid(), workspaceId, fileId],
      )
      await owner.query(
        `INSERT INTO code_chunks
           (id, workspace_id, repository_id, file_id, text, line_start, line_end)
         VALUES ($1, $2, $3, $4, 'export const seed = 1', 1, 1)`,
        [ulid(), workspaceId, repositoryId, fileId],
      )
      const workflowId = ulid()
      await owner.query(
        `INSERT INTO workflows (id, workspace_id, name, version, definition)
         VALUES ($1, $2, 'seed-workflow', 1, '{"steps":[]}'::jsonb)`,
        [workflowId, workspaceId],
      )
      const runId = ulid()
      await owner.query(
        `INSERT INTO runs (id, workspace_id, workflow_name, workflow_version, started_by)
         VALUES ($1, $2, 'seed-workflow', 1, $3)`,
        [runId, workspaceId, userId],
      )
      await owner.query(
        `INSERT INTO run_steps (id, workspace_id, run_id, seq, step_id, step_type, input_hash)
         VALUES ($1, $2, $3, 1, 'seed', 'model', 'seedhash')`,
        [ulid(), workspaceId, runId],
      )
      await owner.query(
        `INSERT INTO run_events (id, workspace_id, run_id, seq, kind)
         VALUES ($1, $2, $3, 1, 'model_call')`,
        [ulid(), workspaceId, runId],
      )
      const notificationId = ulid()
      await owner.query(
        `INSERT INTO notifications
           (id, workspace_id, user_id, kind, subject, target_type, target_id)
         VALUES ($1, $2, $3, 'checkpoint_requested', 'seed', 'checkpoint', $1)`,
        [notificationId, workspaceId, userId],
      )
      await owner.query(
        `INSERT INTO notification_preferences (id, workspace_id, user_id, kind, channel, enabled)
         VALUES ($1, $2, $3, 'job_status', 'email', false)`,
        [ulid(), workspaceId, userId],
      )
      await owner.query(
        `INSERT INTO notification_deliveries (id, workspace_id, notification_id, channel, status)
         VALUES ($1, $2, $3, 'in_app', 'pending')`,
        [ulid(), workspaceId, notificationId],
      )
      await owner.query(
        `INSERT INTO checkpoints
           (id, workspace_id, run_id, step_id, kind, policy_source, mode, expires_at)
         VALUES ($1, $2, $3, 'seed', 'before_create_artefacts', 'platform', 'ask', now() + interval '1 day')`,
        [ulid(), workspaceId, runId],
      )
      const taskId = ulid()
      await owner.query(
        `INSERT INTO tasks (id, workspace_id, team_id, key, title, created_by)
         VALUES ($1, $2, $3, 'CH-1', 'seed task', $4)`,
        [taskId, workspaceId, teamId, userId],
      )
      await owner.query(
        `INSERT INTO task_counters (workspace_id, team_id, next_number) VALUES ($1, $2, 2)`,
        [workspaceId, teamId],
      )
      await owner.query(
        `INSERT INTO artefact_links (id, workspace_id, from_type, from_id, to_type, to_id)
         VALUES ($1, $2, 'task', $3, 'document', $3)`,
        [ulid(), workspaceId, taskId],
      )
      await owner.query(
        `INSERT INTO context_bundles (id, workspace_id, user_id, team_id, query)
         VALUES ($1, $2, $3, $4, 'seed')`,
        [ulid(), workspaceId, userId, teamId],
      )
      await owner.query(
        `INSERT INTO spend_ledger (id, workspace_id, team_id, run_id, provider, model, purpose)
         VALUES ($1, $2, $3, $4, 'fake', 'fake-1', 'chat')`,
        [ulid(), workspaceId, teamId, runId],
      )
      await owner.query(
        `INSERT INTO notification_digest_settings (id, workspace_id, user_id, enabled)
         VALUES ($1, $2, $3, false)`,
        [ulid(), workspaceId, userId],
      )
      await owner.query(
        `INSERT INTO checkpoint_decision_tokens
           (id, workspace_id, checkpoint_id, user_id, token_hash, expires_at)
         SELECT $1, $2, c.id, $3, $1, now() + interval '1 day'
           FROM checkpoints c WHERE c.workspace_id = $2 LIMIT 1`,
        [ulid(), workspaceId, userId],
      )
      await owner.query(
        `INSERT INTO route_map
           (id, workspace_id, repository_id, route_pattern, component_file_id, component_path)
         VALUES ($1, $2, $3, '/', $4, 'src/seed.ts')`,
        [ulid(), workspaceId, repositoryId, fileId],
      )
      await owner.query(
        `INSERT INTO webhook_deliveries
           (id, workspace_id, integration_id, delivery_id, signature_ok, payload)
         VALUES ($1, $2, $3, $1, true, '{}')`,
        [ulid(), workspaceId, integrationId],
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
        case 'policies': {
          const [team] = await tx.query<{ id: string }>(`SELECT id FROM teams LIMIT 1`)
          await tx.execute(
            `INSERT INTO policies (id, workspace_id, team_id, checkpoint_kind, mode)
             VALUES ($1, $2, $3, 'before_coding_job', 'ask')`,
            [id, workspaceId, team?.id ?? null],
          )
          return
        }
        case 'oauth_grants': {
          const [client] = await tx.query<{ id: string }>(`SELECT id FROM oauth_clients LIMIT 1`)
          await tx.execute(
            `INSERT INTO oauth_grants (id, workspace_id, client_id, user_id) VALUES ($1, $2, $3, $4)`,
            [id, workspaceId, client?.id ?? id, userId],
          )
          return
        }
        case 'oauth_tokens': {
          const [grant] = await tx.query<{ id: string }>(`SELECT id FROM oauth_grants LIMIT 1`)
          await tx.execute(
            `INSERT INTO oauth_tokens (id, workspace_id, grant_id, kind, token_hash, expires_at)
             VALUES ($1, $2, $3, 'access', $4, now() + interval '1 hour')`,
            [id, workspaceId, grant?.id ?? id, id],
          )
          return
        }
        case 'workspace_data_keys':
          await tx.execute(
            `INSERT INTO workspace_data_keys (id, workspace_id, wrapped_key) VALUES ($1, $2, $3)`,
            [id, workspaceId, `v1.x.${id}.${id}.${id}`],
          )
          return
        case 'integrations':
          await tx.execute(
            `INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'reference')`,
            [id, workspaceId],
          )
          return
        case 'signals': {
          const [integration] = await tx.query<{ id: string }>(
            `SELECT id FROM integrations LIMIT 1`,
          )
          await tx.execute(
            `INSERT INTO signals
               (id, workspace_id, integration_id, source, external_id, kind, occurred_at, permissions)
             VALUES ($1, $2, $3, 'reference', $1, 'message', now(), '{"visibility":"public","scopeIds":[]}'::jsonb)`,
            [id, workspaceId, integration?.id ?? id],
          )
          return
        }
        case 'repositories': {
          const [team] = await tx.query<{ id: string }>(`SELECT id FROM teams LIMIT 1`)
          const [integration] = await tx.query<{ id: string }>(
            `SELECT id FROM integrations LIMIT 1`,
          )
          await tx.execute(
            `INSERT INTO repositories (id, workspace_id, team_id, integration_id, provider, full_name)
             VALUES ($1, $2, $3, $4, 'github', $1)`,
            [id, workspaceId, team?.id ?? id, integration?.id ?? id],
          )
          return
        }
        case 'repo_index_runs': {
          const [repository] = await tx.query<{ id: string }>(`SELECT id FROM repositories LIMIT 1`)
          await tx.execute(
            `INSERT INTO repo_index_runs (id, workspace_id, repository_id) VALUES ($1, $2, $3)`,
            [id, workspaceId, repository?.id ?? id],
          )
          return
        }
        case 'code_files': {
          const [repository] = await tx.query<{ id: string }>(`SELECT id FROM repositories LIMIT 1`)
          await tx.execute(
            `INSERT INTO code_files (id, workspace_id, repository_id, path, content_hash)
             VALUES ($1, $2, $3, $1, $1)`,
            [id, workspaceId, repository?.id ?? id],
          )
          return
        }
        case 'code_symbols': {
          const [file] = await tx.query<{ id: string }>(`SELECT id FROM code_files LIMIT 1`)
          await tx.execute(
            `INSERT INTO code_symbols (id, workspace_id, file_id, kind, name, line_start, line_end)
             VALUES ($1, $2, $3, 'function', 'x', 1, 1)`,
            [id, workspaceId, file?.id ?? id],
          )
          return
        }
        case 'code_imports': {
          const [file] = await tx.query<{ id: string }>(`SELECT id FROM code_files LIMIT 1`)
          await tx.execute(
            `INSERT INTO code_imports (id, workspace_id, file_id, specifier) VALUES ($1, $2, $3, 'x')`,
            [id, workspaceId, file?.id ?? id],
          )
          return
        }
        case 'code_chunks': {
          const [file] = await tx.query<{ id: string }>(`SELECT id FROM code_files LIMIT 1`)
          await tx.execute(
            `INSERT INTO code_chunks
               (id, workspace_id, repository_id, file_id, text, line_start, line_end)
             SELECT $1, $2, f.repository_id, f.id, 'x', 1, 1
               FROM code_files f WHERE f.id = $3`,
            [id, workspaceId, file?.id ?? id],
          )
          return
        }
        case 'route_map': {
          const [repository] = await tx.query<{ id: string }>(`SELECT id FROM repositories LIMIT 1`)
          await tx.execute(
            `INSERT INTO route_map (id, workspace_id, repository_id, route_pattern, component_path)
             VALUES ($1, $2, $3, $1, 'x')`,
            [id, workspaceId, repository?.id ?? id],
          )
          return
        }
        case 'workflows':
          await tx.execute(
            `INSERT INTO workflows (id, workspace_id, name, version, definition)
             VALUES ($1, $2, $1, 1, '{}'::jsonb)`,
            [id, workspaceId],
          )
          return
        case 'runs':
          await tx.execute(
            `INSERT INTO runs (id, workspace_id, workflow_name, workflow_version, started_by)
             VALUES ($1, $2, 'x', 1, $3)`,
            [id, workspaceId, userId],
          )
          return
        case 'run_steps': {
          const [run] = await tx.query<{ id: string }>(`SELECT id FROM runs LIMIT 1`)
          await tx.execute(
            `INSERT INTO run_steps (id, workspace_id, run_id, seq, step_id, step_type, input_hash)
             VALUES ($1, $2, $3, 1, $1, 'model', 'h')`,
            [id, workspaceId, run?.id ?? id],
          )
          return
        }
        case 'run_events': {
          const [run] = await tx.query<{ id: string }>(`SELECT id FROM runs LIMIT 1`)
          await tx.execute(
            `INSERT INTO run_events (id, workspace_id, run_id, seq, kind)
             VALUES ($1, $2, $3, 1, 'error')`,
            [id, workspaceId, run?.id ?? id],
          )
          return
        }
        case 'checkpoints': {
          const [run] = await tx.query<{ id: string }>(`SELECT id FROM runs LIMIT 1`)
          await tx.execute(
            `INSERT INTO checkpoints
               (id, workspace_id, run_id, step_id, kind, policy_source, mode, expires_at)
             VALUES ($1, $2, $3, $1, 'before_create_artefacts', 'platform', 'ask', now() + interval '1 day')`,
            [id, workspaceId, run?.id ?? id],
          )
          return
        }
        case 'notifications':
          await tx.execute(
            `INSERT INTO notifications
               (id, workspace_id, user_id, kind, subject, target_type, target_id)
             VALUES ($1, $2, $3, 'mention', 'x', 'checkpoint', $1)`,
            [id, workspaceId, userId],
          )
          return
        case 'notification_preferences':
          await tx.execute(
            `INSERT INTO notification_preferences
               (id, workspace_id, user_id, kind, channel, enabled)
             VALUES ($1, $2, $3, 'mention', 'email', true)`,
            [id, workspaceId, userId],
          )
          return
        case 'notification_deliveries': {
          const [notification] = await tx.query<{ id: string }>(
            `SELECT id FROM notifications LIMIT 1`,
          )
          await tx.execute(
            `INSERT INTO notification_deliveries
               (id, workspace_id, notification_id, channel, status)
             VALUES ($1, $2, $3, 'email', 'pending')`,
            [id, workspaceId, notification?.id ?? id],
          )
          return
        }
        case 'tasks': {
          // Falls back to a literal when the team is not visible, so a
          // cross-tenant attempt is *rejected* rather than silently inserting
          // nothing — a SELECT that RLS filters out would make this pass
          // without proving anything.
          const [team] = await tx.query<{ id: string }>(`SELECT id FROM teams LIMIT 1`)
          await tx.execute(
            `INSERT INTO tasks (id, workspace_id, team_id, key, title, created_by)
             VALUES ($1, $2, $3, 'CH-999', 'x', $4)`,
            [id, workspaceId, team?.id ?? id, userId],
          )
          return
        }
        case 'task_counters': {
          const [team] = await tx.query<{ id: string }>(`SELECT id FROM teams LIMIT 1`)
          await tx.execute(
            `INSERT INTO task_counters (workspace_id, team_id, next_number)
             VALUES ($1, $2, 1)
             ON CONFLICT (workspace_id, team_id) DO UPDATE SET next_number = 1`,
            [workspaceId, team?.id ?? id],
          )
          return
        }
        case 'artefact_links':
          await tx.execute(
            `INSERT INTO artefact_links (id, workspace_id, from_type, from_id, to_type, to_id)
             VALUES ($1, $2, 'task', $1, 'document', $1)`,
            [id, workspaceId],
          )
          return
        case 'context_bundles':
          await tx.execute(
            `INSERT INTO context_bundles (id, workspace_id, user_id, query)
             VALUES ($1, $2, $3, 'seed')`,
            [id, workspaceId, userId],
          )
          return
        case 'spend_ledger':
          await tx.execute(
            `INSERT INTO spend_ledger (id, workspace_id, provider, model, purpose)
             VALUES ($1, $2, 'fake', 'fake-1', 'chat')`,
            [id, workspaceId],
          )
          return
        case 'notification_digest_settings':
          await tx.execute(
            `INSERT INTO notification_digest_settings (id, workspace_id, user_id, enabled)
             VALUES ($1, $2, $3, false)`,
            [id, workspaceId, userId],
          )
          return
        case 'checkpoint_decision_tokens': {
          const [checkpoint] = await tx.query<{ id: string }>(
            `SELECT id FROM checkpoints LIMIT 1`,
          )
          await tx.execute(
            `INSERT INTO checkpoint_decision_tokens
               (id, workspace_id, checkpoint_id, user_id, token_hash, expires_at)
             VALUES ($1, $2, $3, $4, $1, now() + interval '1 day')`,
            [id, workspaceId, checkpoint?.id ?? id, userId],
          )
          return
        }
        case 'webhook_deliveries': {
          const [integration] = await tx.query<{ id: string }>(
            `SELECT id FROM integrations LIMIT 1`,
          )
          await tx.execute(
            `INSERT INTO webhook_deliveries
               (id, workspace_id, integration_id, delivery_id, signature_ok, payload)
             VALUES ($1, $2, $3, $1, true, '{}')`,
            [id, workspaceId, integration?.id ?? id],
          )
          return
        }
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
  //
  // Created by catching the duplicate rather than by checking first. A role is
  // cluster-wide, not per-database, so two processes migrating two *different*
  // databases race for the same role — and `IF NOT EXISTS` then `CREATE` is a
  // check-then-act where both see "not exists" and one gets a unique-violation
  // on `pg_authid`. That is a flake in CI and a failed boot when two API
  // replicas start together.
  await admin.execute(`
    DO $$
    BEGIN
      CREATE ROLE ${config.appUser} LOGIN PASSWORD '${config.appPassword}';
    EXCEPTION
      WHEN duplicate_object THEN NULL;
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
