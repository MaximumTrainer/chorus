import { createHash, randomBytes } from 'node:crypto'
import { NotFoundError, ulid } from '@chorus/core'
import { withTenant, type DbConfig } from '@chorus/db'

/**
 * Collaboration tickets (DOC-2 AC5).
 *
 * The collaboration server is a separate process on its own port, and a
 * WebSocket cannot carry the session cookie the browser holds. So the browser
 * asks here — where every rule about who may read what already lives — and
 * presents the answer on the socket.
 *
 * The alternative is teaching the collaboration server to decide for itself
 * whether somebody may read a document. Two implementations of one permission
 * question drift, and the one that drifts is the one nobody is looking at.
 *
 * A ticket therefore carries no authority of its own. It is a receipt for a
 * decision this service already made, for one document, valid for seconds, and
 * spent the moment a socket opens.
 */

/** Long enough to open a socket, short enough that a leaked one is stale. */
const TICKET_TTL_MS = 30_000

export interface CollaborationTicket {
  readonly ticket: string
  /** What the client passes as the Hocuspocus document name. */
  readonly documentName: string
  readonly expiresAt: string
}

export interface CollaborationService {
  issue(input: {
    workspaceId: string
    documentId: string
    userId: string
  }): Promise<CollaborationTicket>
}

/** The name a document is known by on the wire. */
export function documentChannel(workspaceId: string, documentId: string): string {
  return `${workspaceId}/${documentId}`
}

export function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex')
}

export function createCollaborationService(config: DbConfig): CollaborationService {
  return {
    async issue({ workspaceId, documentId, userId }) {
      return withTenant(
        workspaceId,
        async (t) => {
          // Read through the tenant policy, so a document in another workspace
          // is absent rather than forbidden — the same answer WS-2 gives
          // everywhere else, because "it exists but you may not have it" is
          // itself information.
          const [document] = await t.query<{ id: string }>(
            `SELECT id FROM documents WHERE id = $1 AND deleted_at IS NULL`,
            [documentId],
          )
          if (!document) throw new NotFoundError('No such document', { documentId })

          const ticket = randomBytes(32).toString('base64url')
          const expiresAt = new Date(Date.now() + TICKET_TTL_MS)

          await t.execute(
            `INSERT INTO collaboration_tickets
               (id, workspace_id, document_id, user_id, token_hash, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [ulid(), workspaceId, documentId, userId, hashTicket(ticket), expiresAt],
          )

          // Swept here rather than by a scheduled job: a table of dead tickets
          // is a growing record of who opened which document and when, kept for
          // no reason, and this is the only code path that ever writes to it.
          await t.execute(
            `DELETE FROM collaboration_tickets WHERE expires_at < now() - interval '1 hour'`,
          )

          return {
            ticket,
            documentName: documentChannel(workspaceId, documentId),
            expiresAt: expiresAt.toISOString(),
          }
        },
        { config, userId },
      )
    },
  }
}
