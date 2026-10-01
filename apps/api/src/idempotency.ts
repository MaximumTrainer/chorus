import { createHash } from 'node:crypto'
import { ConflictError, ValidationError, ulid } from '@chorus/core'
import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'
import type { AppContext, RouteDefinition } from './routes.js'

/**
 * `Idempotency-Key` on workspace POST routes (MCP-3 AC4, architecture.md §19).
 *
 * A caller that loses the reply to a create cannot know whether it happened.
 * Retrying with the same key returns the first response, so a retry never
 * makes a second artefact. The MCP create tools pass their `idempotencyKey`
 * here, which is why the guarantee lives in the API: a script and an agent get
 * the same one.
 *
 * Only a successful response is remembered. A refused request was never done,
 * so a caller who corrects it and retries with the same key should have it
 * done. A key is kept for a day, which is far longer than any retry loop and
 * short enough that keys need never be cleaned up by hand.
 */

const KEY_LIFETIME_MS = 24 * 60 * 60 * 1000

interface KeyRow {
  readonly request_hash: string
  readonly response_status: number | null
  readonly response_body: string | null
  readonly response_type: string | null
  readonly created_at: Date
}

function requestHash(method: string, path: string, body: string): string {
  return createHash('sha256').update(`${method}\n${path}\n${body}`).digest('hex')
}

/**
 * The middleware for one route. A no-op unless the route is a workspace POST
 * and the caller sent a key, so nothing changes for anyone who does not ask.
 */
export function idempotent(definition: RouteDefinition, dbConfig: DbConfig) {
  return async (c: AppContext, next: () => Promise<void>): Promise<Response | void> => {
    const key = c.req.header('idempotency-key')
    if (definition.method !== 'POST' || definition.auth.kind !== 'workspace' || key === undefined) {
      await next()
      return
    }
    if (key.length < 1 || key.length > 255) {
      throw new ValidationError('Idempotency-Key must be between 1 and 255 characters', {
        field: 'Idempotency-Key',
      })
    }

    const workspaceId = c.req.param('workspaceId')!
    const userId = c.get('user')!.id
    // Read once here; Hono keeps the body, so the handler can still read it.
    const hash = requestHash('POST', c.req.path, await c.req.text())
    const scoped = <T>(work: (tx: TenantTx) => Promise<T>) =>
      withTenant(workspaceId, work, { config: dbConfig, userId })

    const claimed = await scoped(async (tx) => {
      // A key past its lifetime is forgotten, not honoured: replaying a day-old
      // response to a request made today would be the surprising answer.
      await tx.execute(
        `DELETE FROM idempotency_keys
          WHERE user_id = $1 AND key = $2 AND created_at < $3`,
        [userId, key, new Date(Date.now() - KEY_LIFETIME_MS)],
      )
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO idempotency_keys (id, workspace_id, user_id, key, request_hash)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, user_id, key) DO NOTHING
         RETURNING id`,
        [ulid(), workspaceId, userId, key, hash],
      )
      return inserted.length === 1
    })

    if (!claimed) {
      const [existing] = await scoped((tx) =>
        tx.query<KeyRow>(
          `SELECT request_hash, response_status, response_body, response_type, created_at
             FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
          [userId, key],
        ),
      )
      if (!existing) {
        // Released between our insert and our read: the first request failed.
        // The caller retries and finds the key free.
        throw new ConflictError('A request with this Idempotency-Key just failed; retry it')
      }
      if (existing.request_hash !== hash) {
        throw new ValidationError(
          'This Idempotency-Key was already used for a different request. Use a new key for a new request',
          { field: 'Idempotency-Key' },
        )
      }
      if (existing.response_status === null) {
        throw new ConflictError(
          'A request with this Idempotency-Key is still being processed; retry it shortly',
        )
      }
      return new Response(existing.response_body, {
        status: existing.response_status,
        headers: {
          ...(existing.response_type ? { 'content-type': existing.response_type } : {}),
          'idempotent-replayed': 'true',
        },
      })
    }

    let succeeded = false
    try {
      await next()
      succeeded = c.res.status >= 200 && c.res.status < 300
    } finally {
      if (succeeded) {
        const body = await c.res.clone().text()
        await scoped((tx) =>
          tx.execute(
            `UPDATE idempotency_keys
                SET response_status = $1, response_body = $2, response_type = $3
              WHERE user_id = $4 AND key = $5`,
            [c.res.status, body, c.res.headers.get('content-type'), userId, key],
          ),
        )
      } else {
        await scoped((tx) =>
          tx.execute(`DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2`, [userId, key]),
        )
      }
    }
  }
}

