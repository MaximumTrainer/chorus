import {
  NotFoundError,
  ValidationError,
  decryptWithDataKey,
  encryptWithDataKey,
  generateDataKey,
  keyIdOf,
  ulid,
  unwrapDataKey,
  wrapDataKey,
  type ConnectorKind,
  type Keyring,
  type MasterKey,
} from '@chorus/core'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Integration credentials, envelope-encrypted (INT-1 AC1).
 *
 * A per-workspace **data key** encrypts the credentials; a **master key** from
 * the environment wraps the data key. Rotation therefore rewraps one small row
 * per workspace and leaves every credential ciphertext exactly where it is —
 * which is what makes rotation a thing you can actually do rather than a
 * migration that decrypts every secret in the system to disk on its way past.
 *
 * The store is the only code that decrypts. A connector receives its
 * credentials for the duration of one call and has no way to reach the
 * database, so it cannot persist, log or widen them.
 */

export interface IntegrationRecord {
  readonly id: string
  readonly workspaceId: string
  readonly kind: ConnectorKind
  readonly status: 'connected' | 'degraded' | 'failed' | 'disconnected'
  readonly config: Readonly<Record<string, unknown>>
  readonly syncCursor: string | null
}

export interface RotationResult {
  /** Data keys rewrapped under the new master key. */
  readonly rewrapped: number
  /** Data keys already under it — an interrupted rotation re-run finds these. */
  readonly alreadyCurrent: number
}

export interface CredentialStore {
  connect(input: {
    workspaceId: string
    kind: ConnectorKind
    credentials: Readonly<Record<string, string>>
    config?: Readonly<Record<string, unknown>>
    actorId?: string
  }): Promise<IntegrationRecord>
  credentialsFor(workspaceId: string, integrationId: string): Promise<Record<string, string>>
  updateCredentials(
    workspaceId: string,
    integrationId: string,
    credentials: Readonly<Record<string, string>>,
    actorId?: string,
  ): Promise<void>
  get(workspaceId: string, integrationId: string): Promise<IntegrationRecord>
  /**
   * The workspace's connected integration of a kind, if there is one.
   *
   * Returns the oldest where several exist, deliberately: a workspace with two
   * GitHub installations has made a choice this method cannot see, and picking
   * the newest would silently change which one is used the moment a second is
   * connected.
   */
  findByKind(workspaceId: string, kind: ConnectorKind): Promise<IntegrationRecord | undefined>
  /**
   * Rewraps every workspace's data key under `current`.
   *
   * Idempotent by construction: a key already naming the current master is
   * counted and skipped, so an interrupted rotation is safe to re-run and a
   * completed one is cheap to re-run.
   */
  rotateMasterKey(): Promise<RotationResult>
}

interface IntegrationRow {
  id: string
  workspace_id: string
  kind: string
  status: IntegrationRecord['status']
  config: Record<string, unknown>
  sync_cursor: string | null
}

const recordOf = (row: IntegrationRow): IntegrationRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  kind: row.kind as ConnectorKind,
  status: row.status,
  config: row.config,
  syncCursor: row.sync_cursor,
})

export function createCredentialStore(
  config: DbConfig,
  keyring: Keyring,
  current: MasterKey,
): CredentialStore {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>, userId?: string): Promise<T> =>
    withTenant(workspaceId, fn, { config, ...(userId ? { userId } : {}) })

  /**
   * The workspace's data key, created on first use.
   *
   * Inside the caller's transaction, so a concurrent first connect cannot mint
   * a second key — the unique index would reject it, and a second key would
   * split a workspace's credentials into two sets, one of which nothing could
   * later decrypt.
   */
  async function dataKeyFor(t: TenantTx, workspaceId: string): Promise<Buffer> {
    const [existing] = await t.query<{ wrapped_key: string }>(
      `SELECT wrapped_key FROM workspace_data_keys WHERE workspace_id = $1`,
      [workspaceId],
    )
    if (existing) return unwrapDataKey(existing.wrapped_key, keyring, workspaceId)

    const dataKey = generateDataKey()
    await t.execute(
      `INSERT INTO workspace_data_keys (id, workspace_id, wrapped_key) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id) DO NOTHING`,
      [ulid(), workspaceId, wrapDataKey(dataKey, current, workspaceId)],
    )

    // Re-read rather than trusting the insert: on a conflict the row that won
    // holds a different key, and encrypting under the one we generated would
    // produce ciphertext nothing can decrypt.
    const [settled] = await t.query<{ wrapped_key: string }>(
      `SELECT wrapped_key FROM workspace_data_keys WHERE workspace_id = $1`,
      [workspaceId],
    )
    return unwrapDataKey(settled!.wrapped_key, keyring, workspaceId)
  }

  return {
    async connect({ workspaceId, kind, credentials, config: settings, actorId }) {
      if (Object.keys(credentials).length === 0) {
        throw new ValidationError('An integration needs at least one credential', {
          field: 'credentials',
        })
      }

      const id = ulid()
      return tx(
        workspaceId,
        async (t) => {
          const dataKey = await dataKeyFor(t, workspaceId)
          const sealed = encryptWithDataKey(JSON.stringify(credentials), dataKey, workspaceId)

          return mutate(t, {
            workspaceId,
            actor: actorId ? { type: 'user', id: actorId } : { type: 'system' },
            action: 'integration.connect',
            targetType: 'integration',
            targetId: id,
            // The kind and the config, never the credential. An audit trail
            // that records the secret it describes is a second copy of it.
            after: { kind, config: settings ?? {} },
            apply: async () => {
              await t.execute(
                `INSERT INTO integrations (id, workspace_id, kind, encrypted_credentials, config)
                 VALUES ($1, $2, $3, $4, $5)`,
                [id, workspaceId, kind, sealed, JSON.stringify(settings ?? {})],
              )
              return {
                id,
                workspaceId,
                kind,
                status: 'connected' as const,
                config: settings ?? {},
                syncCursor: null,
              }
            },
          })
        },
        actorId,
      )
    },

    async credentialsFor(workspaceId, integrationId) {
      return tx(workspaceId, async (t) => {
        const [row] = await t.query<{ encrypted_credentials: string | null }>(
          `SELECT encrypted_credentials FROM integrations
            WHERE id = $1 AND deleted_at IS NULL`,
          [integrationId],
        )
        // Another workspace's integration and one that never existed are alike
        // from here: row-level security did not surface it, and there is
        // nothing to distinguish.
        if (!row) throw new NotFoundError('No such integration', { integrationId })
        if (!row.encrypted_credentials) {
          throw new NotFoundError('That integration holds no credentials', { integrationId })
        }

        const dataKey = await dataKeyFor(t, workspaceId)
        return JSON.parse(decryptWithDataKey(row.encrypted_credentials, dataKey, workspaceId)) as Record<
          string,
          string
        >
      })
    },

    async updateCredentials(workspaceId, integrationId, credentials, actorId) {
      await tx(
        workspaceId,
        async (t) => {
          const [existing] = await t.query<{ kind: string }>(
            `SELECT kind FROM integrations WHERE id = $1 AND deleted_at IS NULL`,
            [integrationId],
          )
          if (!existing) throw new NotFoundError('No such integration', { integrationId })

          const dataKey = await dataKeyFor(t, workspaceId)
          const sealed = encryptWithDataKey(JSON.stringify(credentials), dataKey, workspaceId)

          await mutate(t, {
            workspaceId,
            actor: actorId ? { type: 'user', id: actorId } : { type: 'system' },
            action: 'integration.credentials_updated',
            targetType: 'integration',
            targetId: integrationId,
            // Which keys were set, never their values — enough to tell a
            // refresh from a re-authorisation without recording the secret.
            after: { kind: existing.kind, credentialKeys: Object.keys(credentials).sort() },
            apply: () =>
              t.execute(
                `UPDATE integrations SET encrypted_credentials = $1, updated_at = now()
                  WHERE id = $2`,
                [sealed, integrationId],
              ),
          })
        },
        actorId,
      )
    },

    async findByKind(workspaceId, kind) {
      const [row] = await tx(workspaceId, (t) =>
        t.query<IntegrationRow>(
          `SELECT id, workspace_id, kind, status, config, sync_cursor
             FROM integrations
            WHERE kind = $1 AND deleted_at IS NULL
            ORDER BY created_at ASC
            LIMIT 1`,
          [kind],
        ),
      )
      return row ? recordOf(row) : undefined
    },

    async get(workspaceId, integrationId) {
      const [row] = await tx(workspaceId, (t) =>
        t.query<IntegrationRow>(
          `SELECT id, workspace_id, kind, status, config, sync_cursor
             FROM integrations WHERE id = $1 AND deleted_at IS NULL`,
          [integrationId],
        ),
      )
      if (!row) throw new NotFoundError('No such integration', { integrationId })
      return recordOf(row)
    },

    async rotateMasterKey() {
      // Workspaces are enumerated outside any tenant context — `workspaces`
      // carries no workspace_id and is not a tenant table — and each rewrap
      // then happens inside its own workspace's context. Rotation is a
      // cross-tenant *operation*, but it is never a cross-tenant *read*.
      const workspaces = await withTenant(
        '__none__',
        (t) => t.query<{ id: string }>(`SELECT id FROM workspaces WHERE deleted_at IS NULL`),
        { config },
      )

      let rewrapped = 0
      let alreadyCurrent = 0

      for (const workspace of workspaces) {
        await tx(workspace.id, async (t) => {
          const [row] = await t.query<{ id: string; wrapped_key: string }>(
            `SELECT id, wrapped_key FROM workspace_data_keys WHERE workspace_id = $1 FOR UPDATE`,
            [workspace.id],
          )
          if (!row) return

          // Skipped rather than rewrapped, which is what makes an interrupted
          // rotation safe to re-run and a completed one cheap to re-run.
          if (keyIdOf(row.wrapped_key) === current.id) {
            alreadyCurrent += 1
            return
          }

          // The data key exists in memory for the length of this statement and
          // is never written anywhere but back into its own wrapped form.
          const dataKey = unwrapDataKey(row.wrapped_key, keyring, workspace.id)
          await t.execute(
            `UPDATE workspace_data_keys SET wrapped_key = $1, updated_at = now() WHERE id = $2`,
            [wrapDataKey(dataKey, current, workspace.id), row.id],
          )
          rewrapped += 1
        })
      }

      return { rewrapped, alreadyCurrent }
    },
  }
}
