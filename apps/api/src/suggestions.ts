import {
  NotFoundError,
  ValidationError,
  ConflictError,
  countText,
  documentToMarkdown,
  replaceText,
  ulid,
  type DocumentBody,
} from '@chorus/core'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'
import { decodeBody, rewriteBody } from '@chorus/ui/schema'

/**
 * Suggested edits (DOC-3).
 *
 * > An agent that rewrites your document in place is an agent you stop
 * > trusting after the first bad rewrite.
 *
 * So a suggestion lives beside the document and never inside it, and the
 * document stays byte-identical until somebody accepts one. That is a property
 * of *where the data is*, not of how carefully every reader behaves — which is
 * the point: a guarantee that holds only while every consumer remembers to
 * filter pending text out is not a guarantee.
 *
 * A suggestion is anchored by the text it replaces rather than by a position.
 * A position goes stale the moment anyone types anywhere before it; the text
 * goes stale only when the text itself changes, which is exactly when a
 * suggestion should stop applying (AC5).
 */

export const SUGGESTION_DECISIONS = ['accept', 'reject'] as const
export type SuggestionDecision = (typeof SUGGESTION_DECISIONS)[number]

export function isSuggestionDecision(value: unknown): value is SuggestionDecision {
  return typeof value === 'string' && (SUGGESTION_DECISIONS as readonly string[]).includes(value)
}

export interface SuggestionView {
  /** Set only when a suggestion turned out not to apply. */
  readonly staleReason?: 'gone' | 'ambiguous'
  readonly id: string
  readonly sequence: number
  readonly status: string
  readonly originalText: string
  readonly replacementText: string
  readonly reason: string | null
  readonly decidedBy: string | null
}

export interface SuggestionSetView {
  readonly id: string
  readonly documentId: string
  readonly instruction: string
  readonly status: string
  readonly error: string | null
  readonly createdBy: string
  readonly createdAt: string
  readonly suggestions: readonly SuggestionView[]
}

/**
 * How a set of suggestions is produced.
 *
 * Injected, like `resumeRun`: in a deployment this enqueues and the set is
 * filled in by a worker; in a test it runs inline. The route does not care,
 * because either way it answers with the set as it stands — which is also what
 * a client polls.
 */
export interface EditSuggester {
  (input: {
    workspaceId: string
    documentId: string
    setId: string
    teamId: string
    userId: string
    instruction: string
    passage: string
  }): Promise<void>
}

export interface SuggestionService {
  ask(input: {
    workspaceId: string
    documentId: string
    userId: string
    instruction: string
    selection?: { from: number; to: number }
  }): Promise<SuggestionSetView>
  get(workspaceId: string, setId: string): Promise<SuggestionSetView>
  listFor(workspaceId: string, documentId: string): Promise<SuggestionSetView[]>
  decide(input: {
    workspaceId: string
    suggestionId: string
    userId: string
    decision: SuggestionDecision
  }): Promise<SuggestionView>
  decideSet(input: {
    workspaceId: string
    setId: string
    userId: string
    decision: SuggestionDecision
  }): Promise<SuggestionSetView>
}

interface SetRow {
  id: string
  document_id: string
  instruction: string
  status: string
  error: string | null
  created_by: string
  created_at: Date
}

interface SuggestionRow {
  id: string
  sequence: number
  status: string
  original_text: string
  replacement_text: string
  reason: string | null
  decided_by: string | null
}

const toSuggestion = (row: SuggestionRow): SuggestionView => ({
  id: row.id,
  sequence: row.sequence,
  status: row.status,
  originalText: row.original_text,
  replacementText: row.replacement_text,
  reason: row.reason,
  decidedBy: row.decided_by,
})

/**
 * Records the document as it was, for a cause the caller names.
 *
 * Injected rather than imported so the suggestion service does not have to know
 * what a version is — it knows only that accepting a batch of edits is a moment
 * somebody may want to go back to.
 */
export type SnapshotTaker = (input: {
  workspaceId: string
  documentId: string
  userId: string
}) => Promise<unknown>

export function createSuggestionService(
  config: DbConfig,
  deps: { suggest?: EditSuggester; snapshot?: SnapshotTaker } = {},
): SuggestionService {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>, userId?: string) =>
    withTenant(workspaceId, fn, { config, ...(userId ? { userId } : {}) })

  const readSet = async (t: TenantTx, setId: string): Promise<SuggestionSetView> => {
    const [set] = await t.query<SetRow>(
      `SELECT id, document_id, instruction, status, error, created_by, created_at
         FROM document_suggestion_sets WHERE id = $1`,
      [setId],
    )
    if (!set) throw new NotFoundError('No such suggestion set', { setId })

    const rows = await t.query<SuggestionRow>(
      `SELECT id, sequence, status, original_text, replacement_text, reason, decided_by
         FROM document_suggestions WHERE set_id = $1 ORDER BY sequence`,
      [setId],
    )

    return {
      id: set.id,
      documentId: set.document_id,
      instruction: set.instruction,
      status: set.status,
      error: set.error,
      createdBy: set.created_by,
      createdAt: set.created_at.toISOString(),
      suggestions: rows.map(toSuggestion),
    }
  }

  return {
    async ask({ workspaceId, documentId, userId, instruction, selection }) {
      const setId = await tx(
        workspaceId,
        async (t) => {
          const [document] = await t.query<{ id: string; team_id: string }>(
            `SELECT id, team_id FROM documents WHERE id = $1 AND deleted_at IS NULL`,
            [documentId],
          )
          if (!document) throw new NotFoundError('No such document', { documentId })

          const id = ulid()
          await t.execute(
            `INSERT INTO document_suggestion_sets
               (id, workspace_id, document_id, created_by, instruction, selection_from,
                selection_to)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              id,
              workspaceId,
              documentId,
              userId,
              instruction,
              selection?.from ?? null,
              selection?.to ?? null,
            ],
          )
          return id
        },
        userId,
      )

      if (deps.suggest) {
        const passage = await tx(workspaceId, async (t) => {
          const [row] = await t.query<{ body_md_cache: string | null; team_id: string }>(
            `SELECT body_md_cache, team_id FROM documents WHERE id = $1`,
            [documentId],
          )
          const whole = row?.body_md_cache ?? ''
          // Sliced to the selection, so the model is shown the passage the
          // person actually offered. Sending the whole document and asking it
          // to restrict itself is an instruction models follow most of the
          // time, which is not the same as scoping.
          return {
            teamId: row?.team_id ?? '',
            text: selection ? whole.slice(selection.from, selection.to) : whole,
          }
        })

        await deps.suggest({
          workspaceId,
          documentId,
          setId,
          teamId: passage.teamId,
          userId,
          instruction,
          passage: passage.text,
        })
      }

      return tx(workspaceId, (t) => readSet(t, setId))
    },

    async get(workspaceId, setId) {
      return tx(workspaceId, (t) => readSet(t, setId))
    },

    async listFor(workspaceId, documentId) {
      return tx(workspaceId, async (t) => {
        const rows = await t.query<{ id: string }>(
          `SELECT id FROM document_suggestion_sets WHERE document_id = $1
            ORDER BY created_at DESC`,
          [documentId],
        )
        return Promise.all(rows.map((row) => readSet(t, row.id)))
      })
    },

    async decide({ workspaceId, suggestionId, userId, decision }) {
      return tx(
        workspaceId,
        async (t) => {
          const [row] = await t.query<SuggestionRow & { set_id: string; document_id: string }>(
            `SELECT s.id, s.sequence, s.status, s.original_text, s.replacement_text, s.reason,
                    s.decided_by, s.set_id, sets.document_id
               FROM document_suggestions s
               JOIN document_suggestion_sets sets ON sets.id = s.set_id
              WHERE s.id = $1`,
            [suggestionId],
          )
          if (!row) throw new NotFoundError('No such suggestion', { suggestionId })
          if (row.status !== 'pending') {
            throw new ValidationError(`This suggestion was already ${row.status}`, {
              field: 'decision',
            })
          }

          return applyDecision(t, {
            workspaceId,
            userId,
            decision,
            documentId: row.document_id,
            suggestion: row,
          })
        },
        userId,
      )
        .then((result) => {
          if (result.status !== 'stale') return result
          // Thrown *after* the transaction that marked it stale, never inside
          // it. Raising the error in the same transaction rolls the mark back,
          // so the caller is told the suggestion is stale and the next reader
          // is still offered it — the first version of this did exactly that.
          throw new ConflictError(
            result.staleReason === 'ambiguous'
              ? 'The text this suggestion replaces now appears more than once, so there is no way to tell which was meant.'
              : 'The text this suggestion replaces has changed since it was written, so it was not applied.',
            { suggestionId },
          )
        })
    },

    async decideSet({ workspaceId, setId, userId, decision }) {
      return tx(
        workspaceId,
        async (t) => {
          const [set] = await t.query<{ document_id: string }>(
            `SELECT document_id FROM document_suggestion_sets WHERE id = $1`,
            [setId],
          )
          if (!set) throw new NotFoundError('No such suggestion set', { setId })

          const rows = await t.query<SuggestionRow>(
            `SELECT id, sequence, status, original_text, replacement_text, reason, decided_by
               FROM document_suggestions
              WHERE set_id = $1 AND status = 'pending'
              ORDER BY sequence`,
            [setId],
          )

          // Before anything is applied, and only when something will be. The
          // moment an agent's edits land is exactly the moment somebody wants
          // to be able to go back to (DOC-5 AC1) — and taking a snapshot for a
          // bulk *rejection*, which changes nothing, would fill the history
          // with versions identical to their neighbours.
          if (deps.snapshot && decision === 'accept' && rows.length > 0) {
            await deps.snapshot({ workspaceId, documentId: set.document_id, userId })
          }

          // Only the ones still open. "Accept the rest" must not quietly undo a
          // decision somebody already made, and a bulk action that reverses an
          // individual one is the reason people stop using bulk actions.
          for (const suggestion of rows) {
            await applyDecision(t, {
              workspaceId,
              userId,
              decision,
              documentId: set.document_id,
              // One at a time, and a stale one does not abort the rest: a set
              // where the third suggestion no longer applies should still
              // apply the other four, and say so about the third.
              suggestion,
            })
          }

          return readSet(t, setId)
        },
        userId,
      )
    },
  }

  /**
   * Records a decision, and applies the edit if it was an acceptance.
   *
   * The application and the record are one transaction. A suggestion marked
   * accepted whose edit did not land — or an edit that landed with nothing
   * saying who agreed to it — are both worse than either failing outright.
   */
  async function applyDecision(
    t: TenantTx,
    input: {
      workspaceId: string
      userId: string
      decision: SuggestionDecision
      documentId: string
      suggestion: SuggestionRow
    },
  ): Promise<SuggestionView> {
    const { suggestion, decision, documentId, workspaceId, userId } = input

    if (decision === 'reject') {
      return settle(t, { workspaceId, userId, suggestion, status: 'rejected', action: 'suggestion.reject' })
    }

    const [row] = await t.query<{ ydoc: Buffer | null; title: string }>(
      `SELECT ydoc, title FROM documents WHERE id = $1 AND deleted_at IS NULL`,
      [documentId],
    )
    if (!row) throw new NotFoundError('No such document', { documentId })

    const body = decodeBody(row.ydoc)
    const rewritten = replaceText(body, suggestion.original_text, suggestion.replacement_text)

    if (!rewritten) {
      // Marked rather than left pending: a suggestion that can never apply
      // should stop being offered. Which of the two reasons it was matters,
      // because they lead somewhere different — one means re-run, the other
      // means quote more — so it travels back with the result.
      const settled = await settle(t, {
        workspaceId,
        userId,
        suggestion,
        status: 'stale',
        action: 'suggestion.stale',
      })
      return {
        ...settled,
        staleReason: countText(body, suggestion.original_text) === 0 ? 'gone' : 'ambiguous',
      }
    }

    return mutate(t, {
      workspaceId,
      actor: { type: 'user', id: userId },
      action: 'suggestion.accept',
      targetType: 'suggestion',
      targetId: suggestion.id,
      before: { text: suggestion.original_text },
      after: { text: suggestion.replacement_text, documentId },
      apply: async () => {
        await t.execute(
          `UPDATE documents SET ydoc = $2, body_md_cache = $3, updated_at = now() WHERE id = $1`,
          [documentId, rewriteBody(row.ydoc, rewritten), markdownFor(row.title, rewritten)],
        )
        const [updated] = await t.query<SuggestionRow>(
          `UPDATE document_suggestions
              SET status = 'accepted', decided_by = $2, decided_at = now()
            WHERE id = $1
            RETURNING id, sequence, status, original_text, replacement_text, reason, decided_by`,
          [suggestion.id, userId],
        )
        return toSuggestion(updated!)
      },
    })
  }

  async function settle(
    t: TenantTx,
    input: {
      workspaceId: string
      userId: string
      suggestion: SuggestionRow
      status: 'rejected' | 'stale'
      action: string
    },
  ): Promise<SuggestionView> {
    return mutate(t, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: input.userId },
      action: input.action,
      targetType: 'suggestion',
      targetId: input.suggestion.id,
      after: { status: input.status },
      apply: async () => {
        const [updated] = await t.query<SuggestionRow>(
          `UPDATE document_suggestions
              SET status = $2, decided_by = $3, decided_at = now()
            WHERE id = $1
            RETURNING id, sequence, status, original_text, replacement_text, reason, decided_by`,
          [input.suggestion.id, input.status, input.userId],
        )
        return toSuggestion(updated!)
      },
    })
  }
}

/** Title then body, matching what the export returns. */
function markdownFor(title: string, body: DocumentBody): string {
  const rendered = documentToMarkdown(body)
  return rendered ? `# ${title}\n\n${rendered}\n` : `# ${title}\n`
}
