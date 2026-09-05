import {
  TemplateSectionSchema,
  ValidationError,
  isDocumentType,
  type TemplateSection,
} from '@chorus/core'
import { route, type RouteDefinition } from './routes.js'
import { caller } from './authorisation.js'
import type { DocumentService } from './documents.js'
import type { CollaborationService } from './collaboration.js'

/**
 * Document routes (DOC-1).
 *
 * The split in AC5 is the interesting one. Creating a document is the everyday
 * act and takes `member`; editing the *template* changes the standard for
 * everybody's future documents, which is a different kind of decision and takes
 * `admin`. Gating creation would make the tool harder to use than the document
 * it replaces.
 */
export function documentRoutes(
  documents: DocumentService,
  collaboration: CollaborationService,
): RouteDefinition[] {
  const parseType = (value: unknown) => {
    if (!isDocumentType(value)) {
      // Refused rather than treated as freeform: silently accepting an unknown
      // type would produce a document nobody can find under any filter.
      throw new ValidationError('type must be a known document type', { field: 'type' })
    }
    return value
  }

  const parseSections = (value: unknown): TemplateSection[] => {
    if (!Array.isArray(value) || value.length === 0) {
      throw new ValidationError('sections must be a non-empty array', { field: 'sections' })
    }
    return value.map((section) => {
      const parsed = TemplateSectionSchema.safeParse(section)
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid section', {
          field: 'sections',
        })
      }
      return parsed.data
    })
  }

  return [
    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/teams/:teamId/templates/:type',
      summary: 'Read a team’s current template for a document type.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(
          await documents.currentTemplate(
            c.req.param('workspaceId'),
            c.req.param('teamId'),
            parseType(c.req.param('type')),
          ),
        ),
    }),

    route({
      method: 'PUT',
      path: '/workspaces/:workspaceId/teams/:teamId/templates/:type',
      summary: 'Publish a new version of a team’s template.',
      // Admin: this decides the standard for every document the team writes
      // from now on.
      auth: { kind: 'workspace', role: 'admin', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { sections?: unknown }
        return c.json(
          await documents.putTemplate({
            workspaceId: c.req.param('workspaceId'),
            teamId: c.req.param('teamId'),
            type: parseType(c.req.param('type')),
            actorId: caller(c).userId,
            sections: parseSections(body.sections),
          }),
        )
      },
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/teams/:teamId/documents',
      summary: 'Create a document from the team’s current template.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { type?: unknown; title?: unknown }
        if (typeof body.title !== 'string' || body.title.trim() === '') {
          throw new ValidationError('title is required', { field: 'title' })
        }

        return c.json(
          await documents.create({
            workspaceId: c.req.param('workspaceId'),
            teamId: c.req.param('teamId'),
            type: parseType(body.type),
            title: body.title.trim(),
            actorId: caller(c).userId,
          }),
          201,
        )
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/documents/:documentId',
      summary: 'Read a document, its sections and the template version it used.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(await documents.get(c.req.param('workspaceId'), c.req.param('documentId'))),
    }),

    route({
      method: 'PATCH',
      path: '/workspaces/:workspaceId/documents/:documentId',
      summary: 'Write content into a document’s sections, addressed by key.',
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { sections?: unknown }
        if (!Array.isArray(body.sections)) {
          throw new ValidationError('sections must be an array', { field: 'sections' })
        }

        const sections = body.sections.map((section) => {
          const entry = section as { key?: unknown; content?: unknown }
          if (typeof entry.key !== 'string' || typeof entry.content !== 'string') {
            throw new ValidationError('each section needs a key and content', {
              field: 'sections',
            })
          }
          return { key: entry.key, content: entry.content }
        })

        return c.json(
          await documents.updateSections({
            workspaceId: c.req.param('workspaceId'),
            documentId: c.req.param('documentId'),
            actorId: caller(c).userId,
            sections,
          }),
        )
      },
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/documents/:documentId/export',
      summary: 'Export a document as Markdown, without the template guidance.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) => {
        const markdown = await documents.exportMarkdown(
          c.req.param('workspaceId'),
          c.req.param('documentId'),
        )
        return c.text(markdown)
      },
    }),

    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/documents/:documentId/collaboration-ticket',
      summary: 'Obtain a short-lived ticket for the document’s realtime channel.',
      // `member` and `write:artefacts`: the channel is read *and* write, and a
      // ticket that opened a read-only socket would be a different feature
      // pretending to be this one. The collaboration server asks no permission
      // question of its own — it trusts this decision, which is why the
      // decision is made here, once, where every other one about documents is.
      auth: { kind: 'workspace', role: 'member', scopes: ['write:artefacts'] },
      handler: async (c) =>
        c.json(
          await collaboration.issue({
            workspaceId: c.req.param('workspaceId'),
            documentId: c.req.param('documentId'),
            userId: caller(c).userId,
          }),
          201,
        ),
    }),

    route({
      method: 'GET',
      path: '/workspaces/:workspaceId/documents/:documentId/readiness',
      summary: 'Report which required sections are still empty.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c) =>
        c.json(await documents.readiness(c.req.param('workspaceId'), c.req.param('documentId'))),
    }),
  ]
}
