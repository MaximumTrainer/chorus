import { createHash, randomBytes } from 'node:crypto'
import {
  ConflictError,
  ForbiddenError,
  PROVIDER_SCOPE_SOURCES,
  ValidationError,
  ulid,
  type ExternalIdentityProvider,
  type LinkableProvider,
} from '@chorus/core'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Linking a Chorus user to their own account at a source (NFR-4 AC1, AND1).
 *
 * Restricted content reaches a person only through an account they proved they
 * own — explicit link, never an email match. The proof is an OAuth code flow
 * with PKCE, and because this grants access, it is built against the classic
 * account-linking attack: an attacker starts a link and tricks someone else,
 * signed in as themselves, into completing it, binding the victim's account —
 * and its group access — to the attacker. So a link request is bound to the
 * person who started it, completes only for that person, is used at most once,
 * and lapses after a few minutes. The verifier never leaves the server, and the
 * state is stored hashed.
 *
 * Only the account id is kept; the tokens obtained to learn it are discarded.
 */

/** How long a started link stays completable. A sign-in takes seconds, not hours. */
const REQUEST_TTL_MINUTES = 10

const INVALID_REQUEST = 'This account link request is no longer valid. Start the link again.'

export interface LinkedAccount {
  readonly provider: string
  readonly accountId: string
}

export interface LinkedAccountService {
  start(input: {
    readonly workspaceId: string
    readonly userId: string
    readonly identity: ExternalIdentityProvider
    readonly redirectUri: string
  }): Promise<{ readonly authorizationUrl: string }>
  complete(input: {
    readonly state: string
    readonly code: string
    readonly userId: string
    readonly identity: ExternalIdentityProvider
    readonly redirectUri: string
  }): Promise<LinkedAccount>
  list(input: { readonly workspaceId: string; readonly userId: string }): Promise<{ readonly accounts: LinkedAccount[] }>
  unlink(input: {
    readonly workspaceId: string
    readonly userId: string
    readonly provider: LinkableProvider
  }): Promise<{ readonly unlinked: boolean; readonly revokedScopes: number }>
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const challengeFor = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url')

/** The workspace a state belongs to: it is the state's prefix, which keeps the lookup inside one tenant. */
function workspaceOf(state: string): string | null {
  const dot = state.indexOf('.')
  if (dot <= 0) return null
  const workspaceId = state.slice(0, dot)
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(workspaceId) ? workspaceId : null
}

export function createLinkedAccountService(config: DbConfig): LinkedAccountService {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>): Promise<T> =>
    withTenant(workspaceId, fn, { config })

  return {
    async start({ workspaceId, userId, identity, redirectUri }) {
      const state = `${workspaceId}.${randomBytes(32).toString('base64url')}`
      const verifier = randomBytes(48).toString('base64url')
      await tx(workspaceId, (t) =>
        t.execute(
          `INSERT INTO account_link_requests
             (id, workspace_id, user_id, provider, state_hash, code_verifier, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' minutes')::interval)`,
          [ulid(), workspaceId, userId, identity.provider, hash(state), verifier, String(REQUEST_TTL_MINUTES)],
        ),
      )
      return {
        authorizationUrl: identity.authorizationUrl({ state, codeChallenge: challengeFor(verifier), redirectUri }),
      }
    },

    async complete({ state, code, userId, identity, redirectUri }) {
      const workspaceId = workspaceOf(state)
      if (!workspaceId || code === '') throw new ValidationError(INVALID_REQUEST, { field: 'state' })

      // Consume the request first, in its own committed transaction: whatever
      // happens next, this state can never be presented again.
      const claimed = await tx(workspaceId, async (t) => {
        const [request] = await t.query<{
          id: string
          user_id: string
          provider: string
          code_verifier: string
          live: boolean
        }>(
          `SELECT id, user_id, provider, code_verifier, expires_at > now() AS live
             FROM account_link_requests WHERE state_hash = $1 FOR UPDATE`,
          [hash(state)],
        )
        if (!request) return { outcome: 'invalid' as const }
        await t.execute(`DELETE FROM account_link_requests WHERE id = $1`, [request.id])
        if (request.user_id !== userId) return { outcome: 'not_yours' as const }
        if (!request.live || request.provider !== identity.provider) return { outcome: 'invalid' as const }
        const [member] = await t.query<{ id: string }>(
          `SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [workspaceId, userId],
        )
        if (!member) return { outcome: 'not_yours' as const }
        return { outcome: 'ok' as const, verifier: request.code_verifier }
      })
      if (claimed.outcome === 'invalid') throw new ValidationError(INVALID_REQUEST, { field: 'state' })
      if (claimed.outcome === 'not_yours') {
        // The code is never exchanged on someone else's behalf.
        throw new ForbiddenError('This account link was started by someone else and cannot be completed here.')
      }

      const accountId = await identity.accountIdFor({ code, codeVerifier: claimed.verifier, redirectUri })

      return tx(workspaceId, async (t) => {
        const [claimedByOther] = await t.query<{ user_id: string }>(
          `SELECT user_id FROM linked_accounts WHERE provider = $1 AND account_id = $2 AND user_id <> $3`,
          [identity.provider, accountId, userId],
        )
        if (claimedByOther) {
          throw new ConflictError('That account is already linked to someone else in this workspace.')
        }
        const [previous] = await t.query<{ account_id: string }>(
          `SELECT account_id FROM linked_accounts WHERE user_id = $1 AND provider = $2`,
          [userId, identity.provider],
        )
        return mutate(t, {
          workspaceId,
          actor: { type: 'user', id: userId },
          action: 'linked_account.link',
          targetType: 'user',
          targetId: userId,
          ...(previous ? { before: { provider: identity.provider, accountId: previous.account_id } } : {}),
          after: { provider: identity.provider, accountId },
          apply: async () => {
            // Relinking to a different account drops what the old one granted;
            // the next membership sync grants the new one's.
            if (previous && previous.account_id !== accountId) {
              await t.execute(
                `DELETE FROM source_scope_memberships WHERE user_id = $1 AND source = ANY($2)`,
                [userId, [...PROVIDER_SCOPE_SOURCES[identity.provider]]],
              )
            }
            await t.execute(
              `INSERT INTO linked_accounts (id, workspace_id, user_id, provider, account_id)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (workspace_id, user_id, provider)
               DO UPDATE SET account_id = EXCLUDED.account_id, linked_at = now()`,
              [ulid(), workspaceId, userId, identity.provider, accountId],
            )
            return { provider: identity.provider, accountId }
          },
        })
      })
    },

    async list({ workspaceId, userId }) {
      const rows = await tx(workspaceId, (t) =>
        t.query<{ provider: string; account_id: string }>(
          `SELECT provider, account_id FROM linked_accounts WHERE user_id = $1 ORDER BY provider`,
          [userId],
        ),
      )
      return { accounts: rows.map((r) => ({ provider: r.provider, accountId: r.account_id })) }
    },

    async unlink({ workspaceId, userId, provider }) {
      return tx(workspaceId, async (t) => {
        const [link] = await t.query<{ account_id: string }>(
          `SELECT account_id FROM linked_accounts WHERE user_id = $1 AND provider = $2`,
          [userId, provider],
        )
        if (!link) return { unlinked: false, revokedScopes: 0 }
        const sources = [...PROVIDER_SCOPE_SOURCES[provider]]
        const held = await t.query<{ scope_id: string }>(
          `SELECT scope_id FROM source_scope_memberships WHERE user_id = $1 AND source = ANY($2)`,
          [userId, sources],
        )
        return mutate(t, {
          workspaceId,
          actor: { type: 'user', id: userId },
          action: 'linked_account.unlink',
          targetType: 'user',
          targetId: userId,
          before: { provider, accountId: link.account_id, scopeIds: held.map((h) => h.scope_id).sort() },
          after: { provider, accountId: null, scopeIds: [] },
          apply: async () => {
            await t.execute(`DELETE FROM linked_accounts WHERE user_id = $1 AND provider = $2`, [userId, provider])
            // Access the account granted ends now, not at the next sync (AND1).
            await t.execute(
              `DELETE FROM source_scope_memberships WHERE user_id = $1 AND source = ANY($2)`,
              [userId, sources],
            )
            return { unlinked: true, revokedScopes: held.length }
          },
        })
      })
    },
  }
}
