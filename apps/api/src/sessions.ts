import {
  NotFoundError,
  ValidationError,
  applyTemplate,
  bodyFromTemplate,
  DEFAULT_TEMPLATES,
  documentToMarkdown,
  ulid,
  withSection,
} from '@chorus/core'
import { encodeBody } from '@chorus/ui/schema'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Sessions and their entry points (CHAT-1).
 *
 * > Three named doors, and a short list of team-configured starting moves,
 * > convert "what do I type" into "which of these am I doing".
 *
 * The door is recorded rather than inferred from whether a seed happens to be
 * present: *Nothing* and an idea somebody left blank are different situations,
 * and collapsing them would make the one case AC3 protects — a genuinely
 * unseeded session — indistinguishable from a mistake.
 *
 * Each door carries a routing hint except *Nothing*, which carries none on
 * purpose. An agent that invents a subject for somebody who said they wanted to
 * think out loud has taken the blank page and made it worse: now they have to
 * argue with a wrong premise before they can start.
 */

export const ENTRY_POINTS = ['idea', 'document', 'nothing', 'quick_action'] as const
export type EntryPoint = (typeof ENTRY_POINTS)[number]

export function isEntryPoint(value: unknown): value is EntryPoint {
  return typeof value === 'string' && (ENTRY_POINTS as readonly string[]).includes(value)
}

/** What each door suggests to the router. `nothing` deliberately suggests nothing. */
const HINTS: Readonly<Record<EntryPoint, string | null>> = {
  idea: 'shape-idea',
  document: 'draft-document',
  nothing: null,
  quick_action: null,
}

export interface QuickAction {
  readonly key: string
  readonly label: string
  readonly prompt: string
  readonly hint: string | null
}

export interface SessionMessage {
  readonly seq: number
  readonly role: string
  readonly content: Record<string, unknown>
  readonly createdAt: string
}

export interface SessionRecord {
  readonly id: string
  readonly teamId: string
  readonly title: string
  readonly entryPoint: EntryPoint
  readonly routingHint: string | null
  readonly messages: readonly SessionMessage[]
  readonly createdAt: string
}

export interface StartSession {
  readonly workspaceId: string
  readonly teamId: string
  readonly actorId: string
  readonly entryPoint: EntryPoint
  readonly seed?: string
  readonly title?: string
  readonly sourceType?: string
  readonly sourceId?: string
  readonly pastedText?: string
  readonly quickActionKey?: string
}

export interface SessionService {
  start(input: StartSession): Promise<SessionRecord>
  get(workspaceId: string, sessionId: string): Promise<SessionRecord>
  sources(
    workspaceId: string,
    sessionId: string,
  ): Promise<Array<{ toType: string; toId: string; relation: string }>>
  quickActions(workspaceId: string, teamId: string): Promise<QuickAction[]>
  putQuickActions(input: {
    workspaceId: string
    teamId: string
    actorId: string
    actions: readonly QuickAction[]
  }): Promise<QuickAction[]>
}

/**
 * A title from what somebody actually said.
 *
 * "Untitled" is what a session is called when nobody can find it again. The
 * first line, trimmed, is almost always what the person would have typed as a
 * title anyway.
 */
function titleFrom(seed: string): string {
  const firstLine = seed.split('\n').find((line) => line.trim() !== '')?.trim() ?? 'Untitled'
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine
}

export function createSessionService(config: DbConfig): SessionService {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>, userId?: string) =>
    withTenant(workspaceId, fn, { config, ...(userId ? { userId } : {}) })

  const read = async (t: TenantTx, sessionId: string): Promise<SessionRecord> => {
    const [row] = await t.query<{
      id: string
      team_id: string
      title: string
      entry_point: EntryPoint
      routing_hint: string | null
      created_at: Date
    }>(
      `SELECT id, team_id, title, entry_point, routing_hint, created_at
         FROM chat_sessions WHERE id = $1 AND deleted_at IS NULL`,
      [sessionId],
    )
    if (!row) throw new NotFoundError('No such session', { sessionId })

    const messages = await t.query<{
      seq: number
      role: string
      content: Record<string, unknown>
      created_at: Date
    }>(
      `SELECT seq, role, content, created_at FROM messages
        WHERE session_id = $1 ORDER BY seq`,
      [sessionId],
    )

    return {
      id: row.id,
      teamId: row.team_id,
      title: row.title,
      entryPoint: row.entry_point,
      routingHint: row.routing_hint,
      createdAt: row.created_at.toISOString(),
      messages: messages.map((message) => ({
        seq: message.seq,
        role: message.role,
        content: message.content,
        createdAt: message.created_at.toISOString(),
      })),
    }
  }

  return {
    async start(input) {
      return tx(
        input.workspaceId,
        async (t) => {
          const id = ulid()
          let seed = input.seed?.trim() ?? ''
          let hint = HINTS[input.entryPoint]
          let sourceType = input.sourceType
          let sourceId = input.sourceId

          if (input.entryPoint === 'quick_action') {
            const [action] = await t.query<{ prompt: string; hint: string | null }>(
              `SELECT prompt, hint FROM quick_actions WHERE team_id = $1 AND key = $2`,
              [input.teamId, input.quickActionKey ?? ''],
            )
            // Scoped to this team. A quick action leaking across teams would
            // seed a session with another team's framing, which is worse than
            // no quick action at all.
            if (!action) {
              throw new ValidationError(
                `This team has no quick action "${input.quickActionKey ?? ''}"`,
                { field: 'quickActionKey' },
              )
            }
            seed = action.prompt
            hint = action.hint
          }

          if (input.entryPoint === 'document') {
            if (input.pastedText?.trim()) {
              // Pasted material becomes a real document, with an id, a team and
              // a history. A blob attached to one session is something nothing
              // else can reference, and the "cheapest bridge from existing
              // material" then leads nowhere.
              const documentId = ulid()
              const template = DEFAULT_TEMPLATES.freeform
              const title = input.title?.trim() || titleFrom(input.pastedText)

              // Into the body, not into `sections`. The document has one body
              // (DOC-2), and pasted material that landed anywhere else would be
              // invisible to the editor somebody opens it in.
              const body = withSection(bodyFromTemplate(template), {
                key: template[0]!.key,
                title: template[0]!.title,
                content: input.pastedText.trim(),
              })
              const markdown = documentToMarkdown(body)

              await t.execute(
                `INSERT INTO documents
                   (id, workspace_id, team_id, type, title, sections, ydoc, body_md_cache,
                    created_by)
                 VALUES ($1, $2, $3, 'freeform', $4, $5::jsonb, $6, $7, $8)`,
                [
                  documentId,
                  input.workspaceId,
                  input.teamId,
                  title,
                  JSON.stringify(applyTemplate(template)),
                  encodeBody(body),
                  markdown ? `# ${title}

${markdown}
` : `# ${title}
`,
                  input.actorId,
                ],
              )
              sourceType = 'document'
              sourceId = documentId
            }

            if (!sourceType || !sourceId) {
              throw new ValidationError(
                'The document door needs a source: a pasted document, or one to point at',
                { field: 'sourceId' },
              )
            }

            // A session that quietly lost its source produces an agent turn
            // grounded in nothing, and that reads exactly like one grounded in
            // something (AC5).
            const [exists] = await t.query<{ id: string }>(
              sourceType === 'document'
                ? `SELECT id FROM documents WHERE id = $1 AND deleted_at IS NULL`
                : `SELECT id FROM tasks WHERE id = $1 AND deleted_at IS NULL`,
              [sourceId],
            )
            if (!exists) {
              throw new ValidationError(
                `That ${sourceType} could not be found, so the session would start ungrounded`,
                { field: 'sourceId' },
              )
            }
          }

          const title = input.title?.trim() || (seed ? titleFrom(seed) : 'Untitled')

          await mutate(t, {
            workspaceId: input.workspaceId,
            actor: { type: 'user', id: input.actorId },
            action: 'session.start',
            targetType: 'session',
            targetId: id,
            after: { entryPoint: input.entryPoint, routingHint: hint },
            apply: async () => {
              await t.execute(
                `INSERT INTO chat_sessions
                   (id, workspace_id, team_id, title, entry_point, routing_hint, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [id, input.workspaceId, input.teamId, title, input.entryPoint, hint, input.actorId],
              )

              // The seed is the first message, not just a column on the
              // session: a transcript that starts mid-conversation cannot be
              // read back, quoted, or replayed.
              if (seed) {
                await t.execute(
                  `INSERT INTO messages
                     (id, workspace_id, session_id, seq, role, author_user_id, content)
                   VALUES ($1, $2, $3, 1, 'user', $4, $5::jsonb)`,
                  [ulid(), input.workspaceId, id, input.actorId, JSON.stringify({ text: seed })],
                )
              }

              if (sourceType && sourceId) {
                // Linked, not copied: the session points at the source, so an
                // edit to it is not stranded behind a snapshot nobody knows is
                // stale.
                await t.execute(
                  `INSERT INTO artefact_links
                     (id, workspace_id, from_type, from_id, to_type, to_id, relation, created_by)
                   VALUES ($1, $2, 'session', $3, $4, $5, 'seeded_by', $6)
                   ON CONFLICT DO NOTHING`,
                  [ulid(), input.workspaceId, id, sourceType, sourceId, input.actorId],
                )
              }
            },
          })

          return read(t, id)
        },
        input.actorId,
      )
    },

    async get(workspaceId, sessionId) {
      return tx(workspaceId, (t) => read(t, sessionId))
    },

    async sources(workspaceId, sessionId) {
      return tx(workspaceId, async (t) => {
        const rows = await t.query<{ to_type: string; to_id: string; relation: string }>(
          `SELECT to_type, to_id, relation FROM artefact_links
            WHERE from_type = 'session' AND from_id = $1`,
          [sessionId],
        )
        return rows.map((row) => ({
          toType: row.to_type,
          toId: row.to_id,
          relation: row.relation,
        }))
      })
    },

    async quickActions(workspaceId, teamId) {
      return tx(workspaceId, async (t) => {
        const rows = await t.query<{
          key: string
          label: string
          prompt: string
          hint: string | null
        }>(
          `SELECT key, label, prompt, hint FROM quick_actions
            WHERE team_id = $1 ORDER BY position, key`,
          [teamId],
        )
        return rows
      })
    },

    async putQuickActions({ workspaceId, teamId, actorId, actions }) {
      const keys = new Set(actions.map((action) => action.key))
      if (keys.size !== actions.length) {
        throw new ValidationError('quick action keys must be unique within a team', {
          field: 'actions',
        })
      }

      await tx(
        workspaceId,
        async (t) =>
          mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            action: 'quick_actions.set',
            targetType: 'team',
            targetId: teamId,
            after: { keys: [...keys] },
            apply: async () => {
              // Replaced as a set, because that is how they are edited. A merge
              // would leave an action somebody deliberately deleted still on
              // the home page.
              await t.execute(`DELETE FROM quick_actions WHERE team_id = $1`, [teamId])
              for (const [index, action] of actions.entries()) {
                await t.execute(
                  `INSERT INTO quick_actions
                     (id, workspace_id, team_id, key, label, prompt, hint, position)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                  [
                    ulid(),
                    workspaceId,
                    teamId,
                    action.key,
                    action.label,
                    action.prompt,
                    action.hint,
                    index,
                  ],
                )
              }
            },
          }),
        actorId,
      )

      return this.quickActions(workspaceId, teamId)
    },
  }
}
