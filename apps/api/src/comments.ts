import {
  NotFoundError,
  ValidationError,
  documentToMarkdown,
  locateAnchor,
  ulid,
  type NotificationSink,
} from '@chorus/core'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'
import { decodeBody } from '@chorus/ui/schema'

/**
 * Comments anchored to text (DOC-4).
 *
 * > A lost comment is worse than no comment, because someone believed it was
 * > delivered.
 *
 * Two consequences run through this file. A thread is anchored to the text it
 * quotes rather than to a position, so an edit anywhere else in the document
 * cannot move it. And whether a thread is *orphaned* is computed when it is
 * read, never stored — it is a fact about the document as it is now, and a
 * stored flag would be a second answer to that question, right up until
 * somebody edits the document through a path that forgot to update it.
 */

export interface CommentView {
  readonly id: string
  readonly authorId: string
  readonly body: string
  readonly mentions: readonly string[]
  readonly createdAt: string
}

export interface ThreadView {
  readonly id: string
  readonly documentId: string
  readonly quote: string
  readonly status: string
  /** True when the quoted text is no longer in the document (AC2). */
  readonly orphaned: boolean
  /** Where the quotation sits now, or null for an orphan. */
  readonly anchorFrom: number | null
  readonly anchorTo: number | null
  readonly createdBy: string
  readonly createdAt: string
  readonly comments: readonly CommentView[]
}

export interface CommentService {
  start(input: {
    workspaceId: string
    documentId: string
    userId: string
    quote: string
    prefix?: string
    body: string
    mentions?: readonly string[]
  }): Promise<ThreadView>
  reply(input: {
    workspaceId: string
    threadId: string
    userId: string
    body: string
    mentions?: readonly string[]
  }): Promise<ThreadView>
  listFor(workspaceId: string, documentId: string): Promise<ThreadView[]>
  setResolved(input: {
    workspaceId: string
    threadId: string
    userId: string
    resolved: boolean
  }): Promise<ThreadView>
}

interface ThreadRow {
  id: string
  document_id: string
  quote: string
  quote_prefix: string | null
  status: string
  created_by: string
  created_at: Date
}

interface CommentRow {
  id: string
  author_id: string
  body: string
  mentions: string[]
  created_at: Date
}

export function createCommentService(
  config: DbConfig,
  deps: { notify?: NotificationSink['notify'] } = {},
): CommentService {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>, userId?: string) =>
    withTenant(workspaceId, fn, { config, ...(userId ? { userId } : {}) })

  /** The document's text as anchors are measured against: its rendered body. */
  const textOf = async (t: TenantTx, documentId: string): Promise<string> => {
    const [row] = await t.query<{ ydoc: Buffer | null }>(
      `SELECT ydoc FROM documents WHERE id = $1 AND deleted_at IS NULL`,
      [documentId],
    )
    if (!row) throw new NotFoundError('No such document', { documentId })
    return documentToMarkdown(decodeBody(row.ydoc))
  }

  const readThread = async (t: TenantTx, threadId: string, text: string): Promise<ThreadView> => {
    const [thread] = await t.query<ThreadRow>(
      `SELECT id, document_id, quote, quote_prefix, status, created_by, created_at
         FROM comment_threads WHERE id = $1`,
      [threadId],
    )
    if (!thread) throw new NotFoundError('No such comment thread', { threadId })

    const comments = await t.query<CommentRow>(
      `SELECT id, author_id, body, mentions, created_at
         FROM comments WHERE thread_id = $1 ORDER BY created_at, id`,
      [threadId],
    )

    // Located now, not when it was written. An anchor stored as a position
    // would have had to be rebased against every edit since, and would be
    // wrong without saying so.
    const at = locateAnchor(text, {
      quote: thread.quote,
      ...(thread.quote_prefix ? { prefix: thread.quote_prefix } : {}),
    })

    return {
      id: thread.id,
      documentId: thread.document_id,
      quote: thread.quote,
      status: thread.status,
      orphaned: !at.found,
      anchorFrom: at.found ? at.from : null,
      anchorTo: at.found ? at.to : null,
      createdBy: thread.created_by,
      createdAt: thread.created_at.toISOString(),
      comments: comments.map((row) => ({
        id: row.id,
        authorId: row.author_id,
        body: row.body,
        mentions: row.mentions,
        createdAt: row.created_at.toISOString(),
      })),
    }
  }

  /**
   * Checks that everybody mentioned is somebody the reader could have meant.
   *
   * Refused rather than dropped: a mention that silently does nothing is the
   * same failure as a lost comment — somebody believes a colleague was asked,
   * and no one finds out otherwise until it matters.
   */
  const checkMentions = async (t: TenantTx, mentions: readonly string[]): Promise<void> => {
    if (mentions.length === 0) return

    const rows = await t.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE user_id = ANY($1)`,
      [[...mentions]],
    )
    const members = new Set(rows.map((row) => row.user_id))
    const outsider = mentions.find((id) => !members.has(id))
    if (outsider) {
      throw new ValidationError(
        'One of the people mentioned is not a member of this workspace, so they would never be told.',
        { field: 'mentions', userId: outsider },
      )
    }
  }

  const announce = async (input: {
    workspaceId: string
    documentId: string
    threadId: string
    authorId: string
    mentions: readonly string[]
    body: string
  }): Promise<void> => {
    // Not the author: being told about your own comment is noise, and noise is
    // what makes people turn notifications off.
    const recipients = [...new Set(input.mentions)].filter((id) => id !== input.authorId)
    if (recipients.length === 0 || !deps.notify) return

    await deps.notify({
      workspaceId: input.workspaceId,
      recipients,
      kind: 'mention',
      subject: 'You were mentioned in a comment',
      body: input.body,
      targetType: 'comment_thread',
      targetId: input.threadId,
      // To the thread, not to the document. "Somebody mentioned you somewhere
      // in a long document" costs more to act on than it saves.
      path: `/workspaces/${input.workspaceId}/documents/${input.documentId}#thread-${input.threadId}`,
    })
  }

  return {
    async start({ workspaceId, documentId, userId, quote, prefix, body, mentions = [] }) {
      const { threadId, text } = await tx(
        workspaceId,
        async (t) => {
          const text = await textOf(t, documentId)

          // Refused rather than accepted as an instant orphan. The author is
          // still here and can point at something real; a comment that was
          // never anchored is one nobody can place later.
          const at = locateAnchor(text, { quote, ...(prefix ? { prefix } : {}) })
          if (!at.found) {
            throw new ValidationError(
              at.reason === 'missing'
                ? 'That text was not found in this document, so the comment would have nothing to point at.'
                : 'That text appears more than once — send enough of what precedes it to say which.',
              { field: 'quote' },
            )
          }

          await checkMentions(t, mentions)

          const id = ulid()
          await mutate(t, {
            workspaceId,
            actor: { type: 'user', id: userId },
            action: 'comment.start',
            targetType: 'comment_thread',
            targetId: id,
            after: { documentId, quote },
            apply: async () => {
              await t.execute(
                `INSERT INTO comment_threads
                   (id, workspace_id, document_id, quote, quote_prefix, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [id, workspaceId, documentId, quote, prefix ?? null, userId],
              )
              await t.execute(
                `INSERT INTO comments (id, workspace_id, thread_id, author_id, body, mentions)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [ulid(), workspaceId, id, userId, body, [...mentions]],
              )
            },
          })

          return { threadId: id, text }
        },
        userId,
      )

      // After the transaction commits. A notification sent inside it can be
      // delivered for a comment that then fails to save — and the recipient
      // follows a link to nothing.
      await announce({ workspaceId, documentId, threadId, authorId: userId, mentions, body })

      return tx(workspaceId, (t) => readThread(t, threadId, text))
    },

    async reply({ workspaceId, threadId, userId, body, mentions = [] }) {
      const { documentId, text } = await tx(
        workspaceId,
        async (t) => {
          const [thread] = await t.query<{ document_id: string }>(
            `SELECT document_id FROM comment_threads WHERE id = $1`,
            [threadId],
          )
          if (!thread) throw new NotFoundError('No such comment thread', { threadId })

          await checkMentions(t, mentions)
          await mutate(t, {
            workspaceId,
            actor: { type: 'user', id: userId },
            action: 'comment.reply',
            targetType: 'comment_thread',
            targetId: threadId,
            after: { mentions: [...mentions] },
            apply: async () => {
              await t.execute(
                `INSERT INTO comments (id, workspace_id, thread_id, author_id, body, mentions)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [ulid(), workspaceId, threadId, userId, body, [...mentions]],
              )
            },
          })

          return { documentId: thread.document_id, text: await textOf(t, thread.document_id) }
        },
        userId,
      )

      await announce({ workspaceId, documentId, threadId, authorId: userId, mentions, body })
      return tx(workspaceId, (t) => readThread(t, threadId, text))
    },

    async listFor(workspaceId, documentId) {
      return tx(workspaceId, async (t) => {
        const text = await textOf(t, documentId)
        const rows = await t.query<{ id: string }>(
          `SELECT id FROM comment_threads WHERE document_id = $1 ORDER BY created_at, id`,
          [documentId],
        )
        // The document is rendered once for the whole list rather than once per
        // thread: a page of twenty comments would otherwise decode the CRDT
        // twenty times to answer the same question.
        return Promise.all(rows.map((row) => readThread(t, row.id, text)))
      })
    },

    async setResolved({ workspaceId, threadId, userId, resolved }) {
      return tx(
        workspaceId,
        async (t) => {
          const [thread] = await t.query<{ document_id: string }>(
            `SELECT document_id FROM comment_threads WHERE id = $1`,
            [threadId],
          )
          if (!thread) throw new NotFoundError('No such comment thread', { threadId })

          await mutate(t, {
            workspaceId,
            actor: { type: 'user', id: userId },
            action: resolved ? 'comment.resolve' : 'comment.reopen',
            targetType: 'comment_thread',
            targetId: threadId,
            after: { status: resolved ? 'resolved' : 'open' },
            apply: async () => {
              // Replies are untouched. Resolving is a state change, not a
              // deletion: the reasoning is the part worth keeping, and it is
              // what somebody reopening the thread needs to read.
              await t.execute(
                `UPDATE comment_threads
                    SET status = $2,
                        resolved_by = CASE WHEN $2 = 'resolved' THEN $3 ELSE NULL END,
                        resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE NULL END
                  WHERE id = $1`,
                [threadId, resolved ? 'resolved' : 'open', userId],
              )
            },
          })

          return readThread(t, threadId, await textOf(t, thread.document_id))
        },
        userId,
      )
    },
  }
}
