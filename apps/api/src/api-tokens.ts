import {
  NotFoundError,
  SCOPES,
  ValidationError,
  hashApiToken,
  looksLikeApiToken,
  mintApiToken,
  ulid,
  type Scope,
} from '@chorus/core'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Personal API tokens (WS-5 AC1, AC2, AC5).
 *
 * A token is a *workspace-scoped* credential: the row carries `workspace_id`,
 * and resolution happens inside that workspace's tenant context. That is a
 * deliberate narrowing rather than an accident of the schema — a leaked token
 * then compromises one workspace rather than everything its holder can reach,
 * and confinement is enforced by the row-level security policy rather than by a
 * predicate some future query might forget.
 *
 * The consequence is that a personal token cannot be presented to a route that
 * names no workspace (`POST /workspaces`, `GET /workspaces`). Those routes are
 * for a person choosing where to work, not for a script, so nothing is lost.
 * The MCP endpoint's OAuth grants are the credential for the wider case.
 */

export interface IssuedApiToken {
  readonly id: string
  readonly name: string
  readonly prefix: string
  readonly scopes: readonly Scope[]
  readonly expiresAt: Date | null
  /** The plaintext, returned exactly once. Never persisted, never logged. */
  readonly token: string
}

export interface ApiTokenSummary {
  readonly id: string
  readonly userId: string
  readonly name: string
  readonly prefix: string
  readonly scopes: readonly Scope[]
  readonly expiresAt: Date | null
  readonly lastUsedAt: Date | null
  readonly createdAt: Date
}

/** What a presented token resolves to. Enough to authorise, and nothing more. */
export interface ResolvedApiToken {
  readonly id: string
  readonly userId: string
  readonly email: string
  readonly scopes: readonly Scope[]
}

export interface ApiTokenService {
  create(input: {
    workspaceId: string
    userId: string
    name: string
    scopes: readonly Scope[]
    expiresInDays?: number
  }): Promise<IssuedApiToken>
  listFor(workspaceId: string, userId: string): Promise<ApiTokenSummary[]>
  /** Undefined for anything not live, in this workspace, right now. */
  resolve(workspaceId: string, presented: string): Promise<ResolvedApiToken | undefined>
  revoke(workspaceId: string, userId: string, tokenId: string): Promise<void>
}

const MAX_NAME_LENGTH = 120

function parseScopes(value: readonly Scope[]): Scope[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError('A token must carry at least one scope', { field: 'scopes' })
  }
  const unknown = value.filter((scope) => !(SCOPES as readonly string[]).includes(scope))
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown scope: ${unknown.join(', ')}`, {
      field: 'scopes',
      allowed: SCOPES,
    })
  }
  // Deduplicated, and in the order SCOPES declares, so two requests asking for
  // the same authority produce the same stored row.
  return SCOPES.filter((scope) => value.includes(scope))
}

interface TokenRow {
  id: string
  user_id: string
  name: string
  token_prefix: string
  scopes: Scope[]
  expires_at: Date | null
  last_used_at: Date | null
  created_at: Date
}

const summaryOf = (row: TokenRow): ApiTokenSummary => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  prefix: row.token_prefix,
  scopes: row.scopes,
  expiresAt: row.expires_at,
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
})

export function createApiTokenService(config: DbConfig): ApiTokenService {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>, userId?: string): Promise<T> =>
    withTenant(workspaceId, fn, { config, ...(userId ? { userId } : {}) })

  return {
    async create({ workspaceId, userId, name, scopes, expiresInDays }) {
      const trimmed = name.trim()
      if (!trimmed) throw new ValidationError('A token needs a name', { field: 'name' })
      if (trimmed.length > MAX_NAME_LENGTH) {
        throw new ValidationError(`A token name may be at most ${MAX_NAME_LENGTH} characters`, {
          field: 'name',
        })
      }
      const granted = parseScopes(scopes)

      if (expiresInDays !== undefined && (!Number.isInteger(expiresInDays) || expiresInDays < 1)) {
        throw new ValidationError('An expiry must be a whole number of days, at least one', {
          field: 'expiresInDays',
        })
      }

      const id = ulid()
      const minted = mintApiToken()
      const expiresAt =
        expiresInDays === undefined
          ? null
          : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)

      await tx(
        workspaceId,
        (t) =>
          mutate(t, {
            workspaceId,
            actor: { type: 'user', id: userId },
            action: 'api_token.create',
            targetType: 'api_token',
            targetId: id,
            // The prefix and scopes, never the token. An audit trail that
            // records the credential it describes is a second copy of it.
            after: { name: trimmed, prefix: minted.prefix, scopes: granted, expiresAt },
            apply: () =>
              t.execute(
                `INSERT INTO api_tokens
                   (id, workspace_id, user_id, name, token_hash, token_prefix, scopes, expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                  id,
                  workspaceId,
                  userId,
                  trimmed,
                  minted.hash,
                  minted.prefix,
                  granted,
                  expiresAt,
                ],
              ),
          }),
        userId,
      )

      return {
        id,
        name: trimmed,
        prefix: minted.prefix,
        scopes: granted,
        expiresAt,
        token: minted.plaintext,
      }
    },

    async listFor(workspaceId, userId) {
      const rows = await tx(
        workspaceId,
        (t) =>
          t.query<TokenRow>(
            `SELECT id, user_id, name, token_prefix, scopes, expires_at, last_used_at, created_at
               FROM api_tokens
              WHERE user_id = $1 AND revoked_at IS NULL AND deleted_at IS NULL
              ORDER BY created_at DESC`,
            [userId],
          ),
        userId,
      )
      return rows.map(summaryOf)
    },

    async resolve(workspaceId, presented) {
      // Rejected on shape before it costs a round trip. A session cookie or an
      // OAuth access token is not a personal token and must not be looked up
      // as one.
      if (!looksLikeApiToken(presented)) return undefined

      const hash = hashApiToken(presented)

      return tx(workspaceId, async (t) => {
        // Liveness is evaluated in the same statement that finds the row, and
        // the row is stamped in the same statement again. Anything else leaves
        // a window in which a revoked token still authorises a request
        // (AC5), and `RETURNING` closes it without a second query.
        const rows = await t.query<{ id: string; user_id: string; scopes: Scope[] }>(
          `UPDATE api_tokens
              SET last_used_at = now()
            WHERE token_hash = $1
              AND revoked_at IS NULL
              AND deleted_at IS NULL
              AND (expires_at IS NULL OR expires_at > now())
          RETURNING id, user_id, scopes`,
          [hash],
        )
        const row = rows[0]
        if (!row) return undefined

        // The holder must still be a member here. A token outlives the
        // membership that justified it otherwise, and removing someone from a
        // workspace would leave their scripts running.
        const [membership] = await t.query<{ email: string }>(
          `SELECT u.email
             FROM workspace_members m
             JOIN users u ON u.id = m.user_id
            WHERE m.user_id = $1 AND m.deleted_at IS NULL AND u.deleted_at IS NULL`,
          [row.user_id],
        )
        if (!membership) return undefined

        return {
          id: row.id,
          userId: row.user_id,
          email: membership.email,
          scopes: row.scopes,
        }
      })
    },

    async revoke(workspaceId, userId, tokenId) {
      await tx(
        workspaceId,
        async (t) => {
          const [existing] = await t.query<TokenRow>(
            `SELECT id, user_id, name, token_prefix, scopes, expires_at, last_used_at, created_at
               FROM api_tokens
              WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND deleted_at IS NULL`,
            [tokenId, userId],
          )
          // Someone else's token, an already-revoked one and one that never
          // existed are all answered the same way: whether a given token id
          // exists is not the revoker's business.
          if (!existing) throw new NotFoundError('No such token', { tokenId })

          await mutate(t, {
            workspaceId,
            actor: { type: 'user', id: userId },
            action: 'api_token.revoke',
            targetType: 'api_token',
            targetId: tokenId,
            before: { name: existing.name, prefix: existing.token_prefix, scopes: existing.scopes },
            after: { revoked: true },
            apply: () =>
              t.execute(
                `UPDATE api_tokens SET revoked_at = now(), updated_at = now() WHERE id = $1`,
                [tokenId],
              ),
          })
        },
        userId,
      )
    },
  }
}
