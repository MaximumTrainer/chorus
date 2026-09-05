import {
  DEFAULT_TEMPLATES,
  NotFoundError,
  ValidationError,
  applyTemplate,
  bodyFromTemplate,
  documentToMarkdown,
  missingSections,
  sectionsOf,
  ulid,
  withSection,
  validateTemplate,
  type DocumentBody,
  type DocumentSection,
  type DocumentType,
  type TemplateSection,
} from '@chorus/core'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'
import { decodeBody, encodeBody, rewriteBody } from '@chorus/ui/schema'

/**
 * Documents and templates (DOC-1).
 *
 * Two rules carry the requirement, and both are about not destroying somebody's
 * work by being helpful.
 *
 * **A template edit is forward-only.** Editing publishes a new version; a
 * document keeps the version it was created with. Rewriting existing documents
 * to match would silently discard whatever people had written into sections the
 * new template dropped — and it would do so at the moment the team was busy
 * improving their standard.
 *
 * **Guidance is never content.** It travels beside the content for display and
 * is excluded from every export. Guidance that reaches an export reads as
 * though the author wrote the platform's questions into their own document, and
 * an agent reading it back treats it as something a person said.
 */

export interface DocumentRecord {
  readonly id: string
  readonly teamId: string
  readonly type: DocumentType
  readonly title: string
  readonly templateVersion: number
  readonly sections: readonly DocumentSection[]
  readonly status: string
  readonly createdBy: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface DocumentService {
  currentTemplate(
    workspaceId: string,
    teamId: string,
    type: DocumentType,
  ): Promise<{ id: string | null; version: number; sections: readonly TemplateSection[] }>
  putTemplate(input: {
    workspaceId: string
    teamId: string
    type: DocumentType
    actorId: string
    sections: readonly TemplateSection[]
  }): Promise<{ version: number; sections: readonly TemplateSection[] }>
  create(input: {
    workspaceId: string
    teamId: string
    type: DocumentType
    title: string
    actorId: string
  }): Promise<DocumentRecord>
  get(workspaceId: string, documentId: string): Promise<DocumentRecord>
  /** Writes content into sections, addressed by key. */
  updateSections(input: {
    workspaceId: string
    documentId: string
    actorId: string
    sections: ReadonlyArray<{ key: string; content: string }>
  }): Promise<DocumentRecord>
  exportMarkdown(workspaceId: string, documentId: string): Promise<string>
  readiness(workspaceId: string, documentId: string): Promise<{ ready: boolean; missing: string[] }>
}

interface DocumentRow {
  id: string
  team_id: string
  type: DocumentType
  title: string
  template_version: number
  sections: DocumentSection[]
  status: string
  created_by: string
  created_at: Date
  updated_at: Date
  ydoc: Buffer | null
}

const COLUMNS = `id, team_id, type, title, template_version, sections, status, created_by,
                 created_at, updated_at, ydoc`

/**
 * A document as its readers see it.
 *
 * The section *content* is read out of the body rather than out of the
 * `sections` column, which now carries structure alone. One source of truth
 * (DOC-2): the editor writes the body, and everything that asks what a document
 * says — this, the export, a prompt — reads the same thing the editor shows.
 */
const toRecord = (row: DocumentRow): DocumentRecord => {
  const written = sectionsOf(decodeBody(row.ydoc))
  return {
  id: row.id,
  teamId: row.team_id,
  type: row.type,
  title: row.title,
  templateVersion: row.template_version,
  sections: row.sections.map((section) => ({ ...section, content: written[section.key] ?? '' })),
  status: row.status,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  }
}

/**
 * The document as Markdown: its title, then its body.
 *
 * The title is a column rather than the body's first heading, because it is
 * what every list, link and search result shows — and a title that lives inside
 * the text is one somebody can delete by pressing backspace in the wrong place.
 */
function markdownOf(title: string, body: DocumentBody): string {
  const rendered = documentToMarkdown(body)
  return rendered ? `# ${title}

${rendered}
` : `# ${title}
`
}

export function createDocumentService(config: DbConfig): DocumentService {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>, userId?: string) =>
    withTenant(workspaceId, fn, { config, ...(userId ? { userId } : {}) })

  const load = async (t: TenantTx, documentId: string): Promise<DocumentRow> => {
    const [row] = await t.query<DocumentRow>(
      `SELECT ${COLUMNS} FROM documents WHERE id = $1 AND deleted_at IS NULL`,
      [documentId],
    )
    if (!row) throw new NotFoundError('No such document', { documentId })
    return row
  }

  /**
   * The team's latest template for a type, or the platform default.
   *
   * The default is not stored on team creation: doing that would freeze every
   * team at whatever the defaults were on the day they signed up, and an
   * improvement to a default would reach nobody.
   */
  const latest = async (
    t: TenantTx,
    teamId: string,
    type: DocumentType,
  ): Promise<{ id: string | null; version: number; sections: readonly TemplateSection[] }> => {
    const [row] = await t.query<{ id: string; version: number; sections: TemplateSection[] }>(
      `SELECT id, version, sections FROM document_templates
        WHERE team_id = $1 AND type = $2
        ORDER BY version DESC LIMIT 1`,
      [teamId, type],
    )
    return row ?? { id: null, version: 1, sections: DEFAULT_TEMPLATES[type] }
  }

  return {
    async currentTemplate(workspaceId, teamId, type) {
      return tx(workspaceId, (t) => latest(t, teamId, type))
    },

    async putTemplate({ workspaceId, teamId, type, actorId, sections }) {
      const problems = validateTemplate(sections)
      if (problems.length > 0) {
        throw new ValidationError(problems[0]!.message, { field: 'sections' })
      }

      return tx(
        workspaceId,
        async (t) => {
          const current = await latest(t, teamId, type)
          // A new version rather than an update. The old one keeps rendering
          // the documents created from it (AC2).
          const version = current.id === null ? 2 : current.version + 1

          await mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            action: 'document_template.publish',
            targetType: 'document_template',
            targetId: `${teamId}:${type}`,
            before: { version: current.version },
            after: { version },
            apply: async () => {
              await t.execute(
                `INSERT INTO document_templates
                   (id, workspace_id, team_id, type, version, sections, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
                [ulid(), workspaceId, teamId, type, version, JSON.stringify(sections), actorId],
              )
            },
          })

          return { version, sections }
        },
        actorId,
      )
    },

    async create({ workspaceId, teamId, type, title, actorId }) {
      return tx(
        workspaceId,
        async (t) => {
          const template = await latest(t, teamId, type)
          const sections = applyTemplate(template.sections)
          const id = ulid()

          // The body is laid out from the template at creation, so a document
          // opens with its headings already there and the editor has something
          // to write into. Guidance stays out of it: a document pre-filled with
          // "Who has this problem?" is one where the guidance must be deleted
          // before anything can be written, and the copy somebody forgets to
          // delete ships as though it were content.
          const body = bodyFromTemplate(template.sections)

          const created = await mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            action: 'document.create',
            targetType: 'document',
            targetId: id,
            after: { type, title, templateVersion: template.version },
            apply: async () => {
              const [row] = await t.query<DocumentRow>(
                `INSERT INTO documents
                   (id, workspace_id, team_id, type, title, template_id, template_version,
                    sections, ydoc, body_md_cache, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
                 RETURNING ${COLUMNS}`,
                [
                  id,
                  workspaceId,
                  teamId,
                  type,
                  title,
                  template.id,
                  template.version,
                  JSON.stringify(sections),
                  encodeBody(body),
                  markdownOf(title, body),
                  actorId,
                ],
              )
              return row!
            },
          })

          return toRecord(created)
        },
        actorId,
      )
    },

    async get(workspaceId, documentId) {
      return tx(workspaceId, async (t) => toRecord(await load(t, documentId)))
    },

    async updateSections({ workspaceId, documentId, actorId, sections }) {
      return tx(
        workspaceId,
        async (t) => {
          const current = await load(t, documentId)

          // Addressed by key, never by position. A team renaming a section
          // must not orphan what people wrote under it, and a reordered
          // template must not move content between sections.
          const written = new Map(sections.map((section) => [section.key, section.content]))

          const unknown = sections.filter(
            (section) => !current.sections.some((existing) => existing.key === section.key),
          )
          if (unknown.length > 0) {
            // Refused rather than appended: a key that is not in the document's
            // template is almost always a typo, and silently creating a section
            // for it hides the mistake until somebody wonders where their
            // writing went.
            throw new ValidationError(
              `This document has no section "${unknown[0]!.key}"`,
              { field: 'sections' },
            )
          }

          const updated = await mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            action: 'document.update',
            targetType: 'document',
            targetId: documentId,
            before: { sections: current.sections.map((s) => s.key) },
            after: { changed: sections.map((s) => s.key) },
            apply: async () => {
              // Written into the body, which is the document. Diffed into the
              // existing CRDT rather than replacing it, so an edit made here
              // and an edit made in an open editor merge the way two people
              // typing merge — a replacement would duplicate rather than
              // overwrite.
              let body = decodeBody(current.ydoc)
              for (const section of current.sections) {
                if (!written.has(section.key)) continue
                body = withSection(body, {
                  key: section.key,
                  title: section.title,
                  content: written.get(section.key)!,
                })
              }

              const [row] = await t.query<DocumentRow>(
                `UPDATE documents
                    SET ydoc = $2, body_md_cache = $3, updated_at = now()
                  WHERE id = $1 RETURNING ${COLUMNS}`,
                [documentId, rewriteBody(current.ydoc, body), markdownOf(current.title, body)],
              )
              return row!
            },
          })

          return toRecord(updated)
        },
        actorId,
      )
    },

    async exportMarkdown(workspaceId, documentId) {
      return tx(workspaceId, async (t) => {
        const row = await load(t, documentId)
        // Rendered from the body rather than served from the cache: the cache
        // is a convenience for search, and anything that disagrees with the
        // body is stale rather than right.
        return markdownOf(row.title, decodeBody(row.ydoc))
      })
    },

    async readiness(workspaceId, documentId) {
      return tx(workspaceId, async (t) => {
        const row = await load(t, documentId)
        // Against what is written in the body, not against the `sections`
        // column — which now carries structure alone, and would report every
        // required section as empty forever.
        const written = sectionsOf(decodeBody(row.ydoc))
        const missing = missingSections(
          row.sections.map((section) => ({ ...section, content: written[section.key] ?? '' })),
        )
        // Reported, never enforced (AC4). A template is a standard, not a gate.
        return { ready: missing.length === 0, missing }
      })
    },
  }
}
