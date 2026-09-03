import { createHash, randomBytes } from 'node:crypto'
import { ulid } from '@chorus/core'
import { createManagedPool, withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Actionable checkpoint links (SLACK-6 AC2, AGENT-3).
 *
 * > Email links must authenticate safely — a single-use, short-lived token
 * > bound to the specific checkpoint, never a general-purpose session link in
 * > an email.
 *
 * This is the decision token architecture.md §11.5 describes, arriving with the
 * first transport that needs one, which is what makes it worth its risk. A link
 * in an email is a bearer credential: it lives in a mailbox, in browser
 * history, in a forwarded thread. So it is bound to one checkpoint and one
 * person, consumed by the first decision, expires with the gate it belongs to,
 * and grants nothing else.
 *
 * 256 bits from a CSPRNG, stored only as a SHA-256 hash. The table is somewhere
 * to check a token against, never somewhere to look one up.
 */

const TOKEN_BYTES = 32

export interface ResolvedDecisionLink {
  readonly workspaceId: string
  readonly checkpointId: string
  readonly userId: string
  /**
   * Why an unusable token is still resolved.
   *
   * A token that exists but is spent was demonstrably held by the person
   * presenting it — guessing 256 bits to land on a consumed row is not a threat
   * model — so answering "you already decided this, and here is what you
   * decided" costs nothing and is the only useful thing to say to someone who
   * clicked twice. An *unknown* token gets no such courtesy, because that is
   * where probing would happen.
   */
  readonly state: 'live' | 'consumed' | 'expired'
}

export function hashDecisionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Mints a link for one recipient of one checkpoint, returning the raw token.
 *
 * The raw value is returned and never persisted, so it exists in exactly two
 * places: the email that carries it, and this return value on the way there.
 *
 * `DO NOTHING` on conflict because re-notifying somebody about a gate they
 * already have a link for must not scatter working credentials across their
 * mailbox — the existing one is returned as unavailable rather than replaced,
 * and the caller simply omits the link.
 */
export async function issueDecisionToken(
  tx: TenantTx,
  input: {
    workspaceId: string
    checkpointId: string
    userId: string
    expiresAt: Date
  },
): Promise<string | undefined> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')

  const rows = await tx.query<{ id: string }>(
    `INSERT INTO checkpoint_decision_tokens
       (id, workspace_id, checkpoint_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (checkpoint_id, user_id) DO NOTHING
     RETURNING id`,
    [
      ulid(),
      input.workspaceId,
      input.checkpointId,
      input.userId,
      hashDecisionToken(token),
      input.expiresAt.toISOString(),
    ],
  )

  return rows.length > 0 ? token : undefined
}

export interface DecisionLinks {
  /** The tenancy a token belongs to, or nothing at all. */
  resolve(token: string): Promise<ResolvedDecisionLink | undefined>
  /** Spends the token. False if it was already spent, or never existed. */
  consume(token: string): Promise<boolean>
  close(): Promise<void>
}

/**
 * Resolution runs on an owner connection.
 *
 * Unavoidably: row-level security keys on a workspace that is not known until
 * the token has been resolved, which is what makes a credential opaque. The
 * privilege is confined to exactly that — this returns the tenancy it found and
 * nothing else, and every read and write after it goes through `withTenant`
 * like anything else.
 */
export function createDecisionLinks(config: DbConfig): DecisionLinks {
  const pool = createManagedPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.ownerUser,
    password: config.ownerPassword,
    max: 3,
    label: 'decision-links',
  })

  return {
    async resolve(token) {
      if (!token) return undefined

      const result = await pool.query<{
        workspace_id: string
        checkpoint_id: string
        user_id: string
        consumed_at: Date | null
        expired: boolean
      }>(
        `SELECT workspace_id, checkpoint_id, user_id, consumed_at, expires_at <= now() AS expired
           FROM checkpoint_decision_tokens
          WHERE token_hash = $1`,
        [hashDecisionToken(token)],
      )

      const row = result.rows[0]
      if (!row) return undefined
      return {
        workspaceId: row.workspace_id,
        checkpointId: row.checkpoint_id,
        userId: row.user_id,
        state: row.consumed_at ? 'consumed' : row.expired ? 'expired' : 'live',
      }
    },

    async consume(token) {
      // Conditional, so two clicks arriving together cannot both spend it. The
      // database decides which was first, exactly as it does for the decision
      // itself.
      const result = await pool.query(
        `UPDATE checkpoint_decision_tokens SET consumed_at = now()
          WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
        [hashDecisionToken(token)],
      )
      return (result.rowCount ?? 0) === 1
    },

    async close() {
      await pool.end()
    },
  }
}

/** Convenience for callers that already hold a config rather than a service. */
export async function issueDecisionTokenFor(
  config: DbConfig,
  input: { workspaceId: string; checkpointId: string; userId: string; expiresAt: Date },
): Promise<string | undefined> {
  return withTenant(input.workspaceId, (tx) => issueDecisionToken(tx, input), { config })
}
