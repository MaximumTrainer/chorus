import { ulid } from '@chorus/core'
import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Two-way document sync: an external edit becomes a suggestion (INT-9 AC6).
 *
 * A document published to Confluence keeps a `document_external_links` row (the
 * reverse of the `chorus-doc-id` property the sink stamps on the page). When the
 * page is edited and the link has opted into two-way sync, the edit is raised as
 * a suggested change on the document — beside it, accept/reject, never an
 * overwrite (DOC-3) — rather than silently replacing what a person wrote.
 *
 * An external edit has no Chorus user behind it, so the suggestion is attributed
 * to a per-workspace integration user; the audit then reads honestly as a
 * machine proposal rather than borrowing a person's name.
 */

const INTEGRATION_USER_PREFIX = 'usr_integration_'

/** Get or create the per-workspace user that integration-sourced edits are attributed to. */
async function integrationUser(t: TenantTx, workspaceId: string): Promise<string> {
  const id = `${INTEGRATION_USER_PREFIX}${workspaceId}`
  await t.execute(
    `INSERT INTO users (id, email, name) VALUES ($1, $2, 'Confluence sync')
     ON CONFLICT (id) DO NOTHING`,
    [id, `integration+${workspaceId}@system.chorus`],
  )
  return id
}

export interface DocumentSync {
  /** Record (or update) a document's link to the external object that mirrors it. */
  linkDocument(input: {
    workspaceId: string
    documentId: string
    externalKind: string
    externalId: string
    twoWay?: boolean
  }): Promise<void>
  /**
   * Raise an external edit as a suggestion on the linked document, or null when
   * there is nothing to raise — no link, the link is one-way, or the two sides
   * already agree. Never touches the document.
   */
  reconcileExternalEdit(input: {
    workspaceId: string
    externalKind: string
    externalId: string
    bodyMarkdown: string
    author?: string
  }): Promise<{ suggestionSetId: string } | null>
}

export function createDocumentSync(config: DbConfig): DocumentSync {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>): Promise<T> =>
    withTenant(workspaceId, fn, { config })

  return {
    async linkDocument({ workspaceId, documentId, externalKind, externalId, twoWay }) {
      await tx(workspaceId, (t) =>
        t.execute(
          `INSERT INTO document_external_links
             (id, workspace_id, document_id, external_kind, external_id, two_way)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (workspace_id, external_kind, external_id)
           DO UPDATE SET document_id = EXCLUDED.document_id, two_way = EXCLUDED.two_way, updated_at = now()`,
          [ulid(), workspaceId, documentId, externalKind, externalId, twoWay ?? false],
        ),
      )
    },

    async reconcileExternalEdit({ workspaceId, externalKind, externalId, bodyMarkdown, author }) {
      return tx(workspaceId, async (t) => {
        const [link] = await t.query<{ document_id: string; two_way: boolean }>(
          `SELECT document_id, two_way FROM document_external_links
            WHERE external_kind = $1 AND external_id = $2`,
          [externalKind, externalId],
        )
        // One-way by default: an edit on a link that has not opted in is left
        // alone, never applied and never raised.
        if (!link || !link.two_way) return null

        const [doc] = await t.query<{ body_md_cache: string | null }>(
          `SELECT body_md_cache FROM documents WHERE id = $1`,
          [link.document_id],
        )
        if (!doc) return null
        const current = doc.body_md_cache ?? ''
        // Nothing to suggest when the sides already agree.
        if (current === bodyMarkdown) return null

        const userId = await integrationUser(t, workspaceId)
        const setId = ulid()
        await t.execute(
          `INSERT INTO document_suggestion_sets
             (id, workspace_id, document_id, created_by, instruction, status)
           VALUES ($1, $2, $3, $4, $5, 'ready')`,
          [setId, workspaceId, link.document_id, userId, `Imported from a Confluence edit${author ? ` by ${author}` : ''}`],
        )
        await t.execute(
          `INSERT INTO document_suggestions
             (id, workspace_id, set_id, sequence, original_text, replacement_text, reason)
           VALUES ($1, $2, $3, 1, $4, $5, 'Edited in Confluence')`,
          [ulid(), workspaceId, setId, current, bodyMarkdown],
        )
        // The document itself is untouched; the suggestion lives beside it.
        return { suggestionSetId: setId }
      })
    },
  }
}
