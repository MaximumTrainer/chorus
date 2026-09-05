import {
  ArtefactRefusedError,
  CreateTaskSchema,
  isDocumentType,
  type ArtefactContext,
  type ArtefactDraft,
  type ArtefactWriter,
  type EmittedArtefact,
} from '@chorus/core'
import { withTenant, type DbConfig } from '@chorus/db'
import type { DocumentService } from './documents.js'
import type { PointerService } from './pointers.js'
import type { TaskService } from './tasks.js'

/**
 * Writing what a workflow emitted (AGENT-1, architecture.md §11.7).
 *
 * > the emit step validates that every pointer resolves to a real file at a
 * > real commit before an artefact is written.
 *
 * The ordering is the whole point and it is easy to get backwards. Writing the
 * artefact and then checking its citations leaves a document that has already
 * been seen, linked to and acted on by the time anybody notices a pointer goes
 * nowhere — and a model that produced one plausible-looking citation will have
 * produced others. So every pointer is resolved first, and a draft carrying one
 * that does not resolve is **refused whole**: partially writing it would
 * produce an artefact that silently says less than the workflow claimed.
 *
 * This lives in `apps/api` rather than in the agent package because it is where
 * the document and task services already are. The runtime reaches it through
 * the `ArtefactWriter` interface in `core`, so neither package imports the
 * other.
 */
export function createArtefactWriter(
  config: DbConfig,
  services: { documents: DocumentService; tasks: TaskService; pointers: PointerService },
): ArtefactWriter {
  /**
   * Whether every citation in a draft names something real.
   *
   * Resolved against the index in one pass, before anything is written, so the
   * refusal names the first bad pointer rather than leaving a half-built
   * artefact behind.
   */
  const checkPointers = async (
    workspaceId: string,
    draft: ArtefactDraft,
  ): Promise<void> => {
    for (const pointer of draft.pointers ?? []) {
      const [file] = await withTenant(
        workspaceId,
        (tx) =>
          tx.query<{ last_line: number | null }>(
            `SELECT (SELECT max(c.line_end) FROM code_chunks c WHERE c.file_id = f.id) AS last_line
               FROM code_files f
              WHERE f.repository_id = $1 AND f.path = $2`,
            [pointer.repositoryId, pointer.path],
          ),
        { config },
      )

      if (!file) {
        throw new ArtefactRefusedError(
          `This ${draft.kind} cites ${pointer.path}, which is not in the index — so the ` +
            `citation would not resolve. Nothing was written.`,
          { path: pointer.path },
        )
      }
      if (file.last_line !== null && pointer.lineEnd > file.last_line) {
        // A range past the end of a file opens to a blank screen rather than
        // an error, which is the kind of broken citation a reader does not
        // notice is broken.
        throw new ArtefactRefusedError(
          `This ${draft.kind} cites ${pointer.path}:${pointer.lineStart}-${pointer.lineEnd}, ` +
            `which runs past the end of the file. Nothing was written.`,
          { path: pointer.path },
        )
      }
    }
  }

  return {
    async emit(draft: ArtefactDraft, context: ArtefactContext): Promise<EmittedArtefact> {
      // First, always. Everything below writes.
      await checkPointers(context.workspaceId, draft)

      if (draft.kind === 'task') {
        const created = await services.tasks.create({
          workspaceId: context.workspaceId,
          teamId: context.teamId,
          actorId: context.actorId,
          task: CreateTaskSchema.parse({
            title: draft.title,
            acceptanceCriteria: (draft.acceptanceCriteria ?? []).map((text) => ({ text })),
            tags: draft.tags ?? [],
          }),
        })

        for (const pointer of draft.pointers ?? []) {
          await services.pointers.addManual({
            workspaceId: context.workspaceId,
            taskId: created.id,
            userId: context.actorId,
            repositoryId: pointer.repositoryId,
            path: pointer.path,
            lineStart: pointer.lineStart,
            lineEnd: pointer.lineEnd,
            ...(pointer.symbolName ? { symbolName: pointer.symbolName } : {}),
          })
        }

        return {
          kind: 'task',
          id: created.id,
          title: created.title,
          pointerCount: draft.pointers?.length ?? 0,
        }
      }

      const type = draft.documentType ?? 'freeform'
      if (!isDocumentType(type)) {
        throw new ArtefactRefusedError(
          `"${type}" is not a document type, so there is no template to write it into.`,
          { documentType: type },
        )
      }

      const sections = Object.entries(draft.sections ?? {})
      if (sections.length > 0) {
        // Checked against the template the document *would* be created from,
        // before it is created. A workflow writing to a section that does not
        // exist was drafted against a template the team has since changed;
        // silently dropping that content is how somebody loses a paragraph
        // without ever seeing it happen, and creating the document first
        // leaves a titled husk behind when the refusal lands — indistinguishable
        // from something a person started and abandoned.
        const template = await services.documents.currentTemplate(
          context.workspaceId,
          context.teamId,
          type,
        )
        const known = new Set(template.sections.map((section) => section.key))
        const unknown = sections.filter(([key]) => !known.has(key))
        if (unknown.length > 0) {
          throw new ArtefactRefusedError(
            `This ${type} writes to section "${unknown[0]![0]}", which its template does not ` +
              `have. The template may have changed since the workflow was written.`,
            { section: unknown[0]![0] },
          )
        }
      }

      const created = await services.documents.create({
        workspaceId: context.workspaceId,
        teamId: context.teamId,
        type,
        title: draft.title,
        actorId: context.actorId,
      })

      if (sections.length > 0) {
        await services.documents.updateSections({
          workspaceId: context.workspaceId,
          documentId: created.id,
          actorId: context.actorId,
          sections: sections.map(([key, content]) => ({ key, content })),
        })
      }

      return {
        kind: 'document',
        id: created.id,
        title: created.title,
        pointerCount: draft.pointers?.length ?? 0,
      }
    },
  }
}
