import {
  ConflictError,
  NotFoundError,
  diffBlocks,
  documentToMarkdown,
  ulid,
  type DiffLine,
} from '@chorus/core'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'
import { decodeBody, rewriteBody } from '@chorus/ui/schema'

/**
 * Version history (DOC-5).
 *
 * > Once an agent can edit a document, a reliable undo is a precondition for
 * > trust. Restore must be additive — destroying history to undo is how people
 * > lose work twice.
 *
 * Nothing here is ever updated in place. A restore writes a new version, and
 * the state it replaced is written as one too — because nobody snapshots the
 * document they are about to lose, and without that moment captured, undoing an
 * undo is impossible.
 */

export const VERSION_CAUSES = [
  'manual',
  'scheduled',
  'approval',
  'suggestions_accepted',
  'restore',
  'pre_restore',
] as const
export type VersionCause = (typeof VERSION_CAUSES)[number]

/**
 * The versions retention must never remove.
 *
 * An approval is the evidence of a decision somebody signed off, and a restore
 * pair is the only record of an undo. Pruning either would delete exactly the
 * history that history is kept for.
 */
const PROTECTED_CAUSES: readonly VersionCause[] = ['approval', 'restore', 'pre_restore']

export interface VersionView {
  readonly id: string
  readonly sequence: number
  readonly cause: VersionCause
  readonly label: string | null
  readonly createdBy: string | null
  readonly createdAt: string
}

export interface VersionService {
  /** Captures the document as it stands. Used by every cause. */
  snapshot(input: {
    workspaceId: string
    documentId: string
    userId: string | null
    cause: VersionCause
    label?: string
  }): Promise<VersionView>
  list(workspaceId: string, documentId: string): Promise<VersionView[]>
  diff(workspaceId: string, fromId: string, toId: string): Promise<DiffLine[]>
  restore(input: {
    workspaceId: string
    documentId: string
    versionId: string
    userId: string
    expectedUpdatedAt?: string
  }): Promise<VersionView>
  prune(input: { workspaceId: string; documentId: string; keepDays: number }): Promise<number>
}

interface VersionRow {
  id: string
  sequence: number
  cause: VersionCause
  label: string | null
  created_by: string | null
  created_at: Date
}

const toView = (row: VersionRow): VersionView => ({
  id: row.id,
  sequence: row.sequence,
  cause: row.cause,
  label: row.label,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
})

export function createVersionService(config: DbConfig): VersionService {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>, userId?: string) =>
    withTenant(workspaceId, fn, { config, ...(userId ? { userId } : {}) })

  /** Captures the document inside a transaction the caller already holds. */
  const capture = async (
    t: TenantTx,
    input: {
      workspaceId: string
      documentId: string
      userId: string | null
      cause: VersionCause
      label?: string | undefined
    },
  ): Promise<VersionView> => {
    const [document] = await t.query<{ ydoc: Buffer | null; title: string }>(
      `SELECT ydoc, title FROM documents WHERE id = $1 AND deleted_at IS NULL`,
      [input.documentId],
    )
    if (!document) throw new NotFoundError('No such document', { documentId: input.documentId })

    const [last] = await t.query<{ next: number }>(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM document_versions WHERE document_id = $1`,
      [input.documentId],
    )

    const body = decodeBody(document.ydoc)
    const id = ulid()
    const [row] = await t.query<VersionRow>(
      `INSERT INTO document_versions
         (id, workspace_id, document_id, sequence, snapshot, body_md, cause, label, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, sequence, cause, label, created_by, created_at`,
      [
        id,
        input.workspaceId,
        input.documentId,
        last?.next ?? 1,
        document.ydoc ?? Buffer.alloc(0),
        // Rendered at capture time. Reading it back later through today's
        // renderer would make an old diff change when the renderer does, which
        // is a history that rewrites itself.
        markdownFor(document.title, documentToMarkdown(body)),
        input.cause,
        input.label ?? null,
        input.userId,
      ],
    )
    return toView(row!)
  }

  return {
    async snapshot({ workspaceId, documentId, userId, cause, label }) {
      return tx(
        workspaceId,
        (t) => capture(t, { workspaceId, documentId, userId, cause, label }),
        userId ?? undefined,
      )
    },

    async list(workspaceId, documentId) {
      return tx(workspaceId, async (t) => {
        const rows = await t.query<VersionRow>(
          `SELECT id, sequence, cause, label, created_by, created_at
             FROM document_versions WHERE document_id = $1 ORDER BY sequence DESC`,
          [documentId],
        )
        return rows.map(toView)
      })
    },

    async diff(workspaceId, fromId, toId) {
      return tx(workspaceId, async (t) => {
        const rows = await t.query<{ id: string; body_md: string }>(
          `SELECT id, body_md FROM document_versions WHERE id = ANY($1)`,
          [[fromId, toId]],
        )
        const from = rows.find((row) => row.id === fromId)
        const to = rows.find((row) => row.id === toId)
        if (!from || !to) {
          throw new NotFoundError('One of those versions does not exist', { fromId, toId })
        }
        return diffBlocks(from.body_md, to.body_md)
      })
    },

    async restore({ workspaceId, documentId, versionId, userId, expectedUpdatedAt }) {
      return tx(
        workspaceId,
        async (t) => {
          const [version] = await t.query<{ snapshot: Buffer; document_id: string }>(
            `SELECT snapshot, document_id FROM document_versions WHERE id = $1`,
            [versionId],
          )
          if (!version || version.document_id !== documentId) {
            throw new NotFoundError('No such version for this document', { versionId })
          }

          const [current] = await t.query<{ ydoc: Buffer | null; title: string; updated_at: Date }>(
            `SELECT ydoc, title, updated_at FROM documents WHERE id = $1 AND deleted_at IS NULL`,
            [documentId],
          )
          if (!current) throw new NotFoundError('No such document', { documentId })

          // AC4. The client restores against the version of the document it was
          // looking at; if the document moved between reading and pressing the
          // button, the honest outcome is a refusal. Merging would produce a
          // document that is half one version and half another — an outcome
          // nobody asked for and nobody can describe afterwards.
          if (
            expectedUpdatedAt !== undefined &&
            current.updated_at.toISOString() !== expectedUpdatedAt
          ) {
            throw new ConflictError(
              'This document changed while the restore was being prepared, so nothing was restored.',
              { documentId, updatedAt: current.updated_at.toISOString() },
            )
          }

          // The state about to be replaced, captured first. Nobody snapshots
          // the document they are about to lose, so without this a restore is
          // itself irreversible — which is the trap the requirement names.
          await capture(t, {
            workspaceId,
            documentId,
            userId,
            cause: 'pre_restore',
            label: 'Before restore',
          })

          const restoredBody = decodeBody(version.snapshot)

          return mutate(t, {
            workspaceId,
            actor: { type: 'user', id: userId },
            action: 'document.restore',
            targetType: 'document',
            targetId: documentId,
            after: { versionId },
            apply: async () => {
              await t.execute(
                `UPDATE documents SET ydoc = $2, body_md_cache = $3, updated_at = now()
                  WHERE id = $1`,
                [
                  documentId,
                  // Diffed into the live CRDT rather than replacing it, so the
                  // document keeps its identity and an open editor sees an
                  // ordinary change rather than a duplicate document.
                  rewriteBody(current.ydoc, restoredBody),
                  markdownFor(current.title, documentToMarkdown(restoredBody)),
                ],
              )

              return capture(t, {
                workspaceId,
                documentId,
                userId,
                cause: 'restore',
                label: `Restored version ${versionId}`,
              })
            },
          })
        },
        userId,
      )
    },

    async prune({ workspaceId, documentId, keepDays }) {
      return tx(workspaceId, async (t) => {
        const rows = await t.query<{ id: string }>(
          `DELETE FROM document_versions
            WHERE document_id = $1
              AND cause <> ALL($2)
              AND created_at < now() - make_interval(days => $3)
            RETURNING id`,
          [documentId, [...PROTECTED_CAUSES], keepDays],
        )
        return rows.length
      })
    },
  }
}

/** Title then body, matching what the export returns. */
function markdownFor(title: string, rendered: string): string {
  return rendered ? `# ${title}\n\n${rendered}\n` : `# ${title}\n`
}
