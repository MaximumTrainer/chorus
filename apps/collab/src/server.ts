import { createHash } from 'node:crypto'
import { Server, type Hocuspocus } from '@hocuspocus/server'
import * as Y from 'yjs'
import { createManagedPool, withTenant, type DbConfig } from '@chorus/db'

/**
 * The collaboration server (DOC-2, architecture.md §5.1).
 *
 * The CRDT is chosen so that the server never resolves a conflict, and it
 * does not. What is left is what this file is entirely about:
 *
 *   - **who may open the socket** — answered by the API, presented here as a
 *     ticket, because two implementations of one permission question drift and
 *     the one that drifts is the one nobody is looking at;
 *   - **whether they may still have it open** — re-checked while the socket
 *     lives, because a connection authorised once and never again means
 *     revoking somebody's access does nothing until they happen to reload;
 *   - **what survives a restart** — the encoded document state, written to the
 *     row the rest of the product already reads.
 */

export interface CollabServerOptions {
  readonly dbConfig: DbConfig
  /** `0` asks the operating system for a free one, which is what tests want. */
  readonly port?: number
  /**
   * How often an open connection's access is re-checked (AC5).
   *
   * Frequent enough that revocation is felt in the session it happens in, rare
   * enough that a thousand idle sockets are not a thousand queries a second.
   */
  readonly recheckMs?: number
}

export interface CollabServer {
  readonly port: number
  /** Where a client connects, with the port actually bound. */
  readonly url: string
  stop(): Promise<void>
}

/** What a presented ticket resolves to. Enough to authorise, and nothing more. */
interface ResolvedTicket {
  readonly workspaceId: string
  readonly documentId: string
  readonly userId: string
}

/**
 * The document name on the wire.
 *
 * Parsed rather than trusted: the workspace it names is the tenant every
 * subsequent query runs under, so a name that does not match the ticket has to
 * be refused before it can be used as one.
 */
function parseChannel(name: string): { workspaceId: string; documentId: string } | null {
  const parts = name.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { workspaceId: parts[0], documentId: parts[1] }
}

export async function createCollabServer(options: CollabServerOptions): Promise<CollabServer> {
  const config = options.dbConfig
  const recheckMs = options.recheckMs ?? 2_000

  // An owner connection, used for exactly one thing: turning an opaque ticket
  // into the workspace it belongs to. Row-level security needs a workspace to
  // be set before it can filter by one, and the presenter of a ticket has not
  // yet proved which workspace they are in — that is the question being asked.
  const tickets = createManagedPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.ownerUser,
    password: config.ownerPassword,
    max: 3,
    label: 'collab-tickets',
  })

  /**
   * Resolves a presented ticket, or refuses.
   *
   * **Not single-use, deliberately.** The obvious design — mark it spent, refuse
   * the second presentation — was written first and does not survive contact
   * with the protocol: the client authenticates more than once while
   * establishing a connection, so a strictly single-use ticket refuses its own
   * rightful holder halfway through the handshake. What protects a ticket is
   * therefore its lifetime, which is seconds, and the fact that it names one
   * document. `used_at` is recorded because "when was this document first
   * opened with this ticket" is worth being able to answer, not because
   * anything authorises on it.
   */
  const spend = async (token: string, channel: string): Promise<ResolvedTicket | null> => {
    const named = parseChannel(channel)
    if (!named) return null

    const hash = createHash('sha256').update(token, 'utf8').digest('hex')
    const { rows } = await tickets.query<{
      workspace_id: string
      document_id: string
      user_id: string
    }>(
      `UPDATE collaboration_tickets
          SET used_at = COALESCE(used_at, now())
        WHERE token_hash = $1
          AND expires_at > now()
          AND workspace_id = $2
          AND document_id = $3
      RETURNING workspace_id, document_id, user_id`,
      [hash, named.workspaceId, named.documentId],
    )

    return rows[0]
      ? {
          workspaceId: rows[0].workspace_id,
          documentId: rows[0].document_id,
          userId: rows[0].user_id,
        }
      : null
  }

  /** Whether this person can still reach this document, asked again. */
  const stillAllowed = async (ticket: ResolvedTicket): Promise<boolean> => {
    const { rows } = await tickets.query<{ ok: boolean }>(
      `SELECT true AS ok
         FROM workspace_members m
         JOIN documents d ON d.workspace_id = m.workspace_id
        WHERE m.workspace_id = $1 AND m.user_id = $2
          AND d.id = $3 AND d.deleted_at IS NULL`,
      [ticket.workspaceId, ticket.userId, ticket.documentId],
    )
    return rows.length > 0
  }

  /** Open connections, so access can be re-checked and revoked ones dropped. */
  const live = new Map<string, { ticket: ResolvedTicket; close: () => void }>()

  const server: Hocuspocus = Server.configure({
    port: options.port ?? 0,

    async onAuthenticate({ token, documentName, connection }) {
      const ticket = await spend(token, documentName)
      if (!ticket) {
        // Thrown, not returned: Hocuspocus reads a rejection as a refusal and
        // closes the socket. Saying why would tell an unauthenticated caller
        // whether the document exists.
        throw new Error('This collaboration ticket is not valid')
      }

      // The ticket authorised a person, not a role. Read-only would be a
      // different feature, and pretending otherwise here would let a change of
      // mind about that go unnoticed.
      connection.requiresAuthentication = true
      return { ticket }
    },

    async connected({ context, socketId, connectionInstance }) {
      const ticket = (context as { ticket?: ResolvedTicket }).ticket
      if (!ticket) return
      // Keyed by socket, not by user: one person may have the same document
      // open in two tabs, and revoking their access has to close both.
      live.set(socketId, { ticket, close: () => connectionInstance.close() })
    },

    async onDisconnect({ socketId }) {
      live.delete(socketId)
    },

    /**
     * Loads the document from the row the rest of the product already reads.
     *
     * `ydoc` is the source of truth for the text; `body_md_cache` is derived
     * from it for search and prompts, and is never read back into the editor —
     * a cache that can become a second source of truth is one that will.
     */
    async onLoadDocument({ documentName, document }) {
      const named = parseChannel(documentName)
      if (!named) return document

      const [row] = await withTenant(
        named.workspaceId,
        (t) =>
          t.query<{ ydoc: Buffer | null }>(`SELECT ydoc FROM documents WHERE id = $1`, [
            named.documentId,
          ]),
        { config },
      )

      if (row?.ydoc) Y.applyUpdate(document, new Uint8Array(row.ydoc))
      return document
    },

    async onStoreDocument({ documentName, document }) {
      const named = parseChannel(documentName)
      if (!named) return

      // The whole state, not a delta. Yjs merges on load, so storing updates
      // incrementally would work too — and would leave the row unreadable
      // without replaying every one of them, which is the thing every other
      // reader of this table would then have to know how to do.
      const state = Buffer.from(Y.encodeStateAsUpdate(document))

      await withTenant(
        named.workspaceId,
        (t) =>
          t.execute(`UPDATE documents SET ydoc = $2, updated_at = now() WHERE id = $1`, [
            named.documentId,
            state,
          ]),
        { config },
      )
    },
  })

  await server.listen()
  const port = server.address.port

  // AC5's second half. A socket authorised once and never again means removing
  // somebody from a workspace has no effect until they happen to reload, which
  // is exactly the moment access control is being relied on.
  const recheck = setInterval(() => {
    void (async () => {
      for (const [key, held] of live) {
        if (await stillAllowed(held.ticket)) continue

        // Expire the ticket *before* closing the socket. A client treats a
        // closed connection as something to retry, and a ticket that is still
        // inside its lifetime would let it straight back in — so closing alone
        // makes revocation look like a network blip and last about a second.
        await tickets.query(
          `UPDATE collaboration_tickets SET expires_at = now()
            WHERE workspace_id = $1 AND document_id = $2 AND user_id = $3`,
          [held.ticket.workspaceId, held.ticket.documentId, held.ticket.userId],
        )
        held.close()
        live.delete(key)
      }
    })()
  }, recheckMs)
  recheck.unref?.()

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    async stop() {
      clearInterval(recheck)
      live.clear()
      // The ticket pool is not ended here. `createManagedPool` returns a
      // process-wide pool keyed by label, so ending it would close the pool the
      // *next* server on this process is about to use — which is exactly what a
      // restart is.
      await server.destroy()
    },
  }
}
