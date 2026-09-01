import { createHash } from 'node:crypto'
import { createManagedPool, type DbConfig } from '@chorus/db'

/**
 * Single-use enforcement for the auth library's stateless tokens (WS-1 AC2).
 *
 * The library signs verification tokens rather than storing them, so there is
 * nothing to consume and a link remains replayable until it expires. The harm
 * from a replay is modest — verification is idempotent and issues no session —
 * but a link leaked through browser history, a proxy log or a forwarded email
 * should not stay usable for its whole lifetime.
 *
 * Only the hash is stored. The table is a record that a token was used, not a
 * place to look tokens up, so keeping the plaintext would add risk and no value.
 */

export interface TokenLedger {
  /**
   * Records the token as used. Returns false if it had already been used, in
   * which case the caller must refuse.
   */
  consume(token: string, purpose: string): Promise<boolean>
  close(): Promise<void>
}

export function createTokenLedger(config: DbConfig): TokenLedger {
  const pool = createManagedPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.ownerUser,
    password: config.ownerPassword,
    max: 3,
    label: 'token-ledger',
  })

  return {
    async consume(token, purpose) {
      const hash = createHash('sha256').update(token, 'utf8').digest('hex')
      // ON CONFLICT DO NOTHING makes this atomic: two concurrent replays cannot
      // both observe an empty table and both succeed.
      const result = await pool.query(
        `INSERT INTO consumed_tokens (token_hash, purpose) VALUES ($1, $2)
         ON CONFLICT (token_hash) DO NOTHING`,
        [hash, purpose],
      )
      return (result.rowCount ?? 0) === 1
    },
    async close() {
      await pool.end()
    },
  }
}
