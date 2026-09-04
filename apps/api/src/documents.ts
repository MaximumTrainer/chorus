import {
  DEFAULT_TEMPLATES,
  NotFoundError,
  ValidationError,
  applyTemplate,
  missingSections,
  toMarkdown,
  ulid,
  validateTemplate,
  type DocumentSection,
  type DocumentType,
  type TemplateSection,
} from '@chorus/core'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'

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
}

const COLUMNS = `id, team_id, type, title, template_version, sections, status, created_by,
                 created_at, updated_at`

const toRecord = (row: DocumentRow): DocumentRecord => ({
  id: row.id,
  teamId: row.team_id,
  type: row.type,
  title: row.title,
  templateVersion: row.template_version,
  sections: row.sections,
  status: row.status,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
})

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
                    sections, body_md_cache, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
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
                  toMarkdown(title, sections),
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
          const merged = current.sections.map((section) =>
            written.has(section.key)
              ? { ...section, content: written.get(section.key)! }
              : section,
          )

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
              const [row] = await t.query<DocumentRow>(
                `UPDATE documents
                    SET sections = $2::jsonb, body_md_cache = $3, updated_at = now()
                  WHERE id = $1 RETURNING ${COLUMNS}`,
                [documentId, JSON.stringify(merged), toMarkdown(current.title, merged)],
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
        // Rendered from `sections` rather than served from the cache: the cache
        // is a convenience for search, and anything that disagrees with the
        // sections is stale rather than right.
        return toMarkdown(row.title, row.sections)
      })
    },

    async readiness(workspaceId, documentId) {
      return tx(workspaceId, async (t) => {
        const row = await load(t, documentId)
        const missing = missingSections(row.sections)
        // Reported, never enforced (AC4). A template is a standard, not a gate.
        return { ready: missing.length === 0, missing }
      })
    },
  }
}
