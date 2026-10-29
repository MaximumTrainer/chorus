import {
  ChatActionSchema,
  atLeast,
  resolveArtefactReference,
  type ArtefactCandidate,
  type ClarificationQuestion,
  type Role,
} from '@chorus/core'
import type { TurnTool, TurnToolContext } from './chat-turn.js'
import type { DocumentService } from './documents.js'
import type { SessionService } from './sessions.js'
import type { TaskService } from './tasks.js'
import type { TeamService } from './teams.js'
import type { WorkspaceService } from './workspaces.js'

/**
 * The chat turn's artefact tools (CHAT-6).
 *
 * One tool, `apply_chat_action`, because the executor runs tools from explicit
 * steps rather than a model-driven loop: the model proposes a `ChatAction`, and
 * this carries it out. It acts as the person — every write passes the acting
 * user's id to the service, and the tool refuses anything their role in the
 * session's team does not permit (AC5). It never reaches past that team: a task
 * is resolved only among the ones the session's team can see, so it cannot edit
 * what the person cannot (the role model has no read-only role, so reach, not a
 * lower role, is what AC5 turns on here).
 */

export interface ChatToolDeps {
  readonly documents: DocumentService
  readonly tasks: TaskService
  readonly sessions: SessionService
  readonly workspaces: WorkspaceService
  readonly teams: TeamService
}

/** The effective role the acting user holds in the session's team, or undefined if none. */
async function roleFor(
  deps: ChatToolDeps,
  ctx: TurnToolContext,
): Promise<Role | undefined> {
  const workspaceRole = await deps.workspaces.roleOf(ctx.workspaceId, ctx.actor.userId)
  if (!workspaceRole) return undefined
  return deps.teams.roleIn(ctx.workspaceId, ctx.teamId, ctx.actor.userId, workspaceRole)
}

const refused = (reason: string) => ({ refused: reason })

const ask = (questions: ClarificationQuestion[]) => ({ asked: true, questions })

export function chatArtefactTools(deps: ChatToolDeps): TurnTool[] {
  return [
    {
      name: 'apply_chat_action',
      description:
        'Carries out what the person asked: create a document, add acceptance criteria to a task ' +
        'they named, or neither. Acts as the person and refuses what they may not do.',
      summarise: (output) => {
        const o = output as Record<string, unknown>
        if (o.created === 'document') return `created a ${String(o.type)}: ${String(o.title)}`
        if (o.refined === 'task') return `updated ${String(o.key)}`
        if (o.asked) return 'asked which one'
        if (o.refused) return `declined: ${String(o.refused)}`
        return 'nothing to change'
      },
      async execute(input, ctx) {
        const parsed = ChatActionSchema.safeParse((input as { action?: unknown }).action ?? input)
        if (!parsed.success) return refused('the action was not understood')
        const action = parsed.data
        if (action.action === 'answer') return { answered: true }

        const role = await roleFor(deps, ctx)
        if (!role || !atLeast(role, 'member')) {
          return refused('you do not have permission to change artefacts in this team')
        }

        if (action.action === 'create_document') {
          const document = await deps.documents.create({
            workspaceId: ctx.workspaceId,
            teamId: ctx.teamId,
            type: action.documentType ?? 'prd',
            title: action.title ?? 'Untitled',
            actorId: ctx.actor.userId,
          })
          await deps.sessions.linkArtefact({
            workspaceId: ctx.workspaceId,
            sessionId: String((input as { sessionId?: unknown }).sessionId ?? ''),
            actorId: ctx.actor.userId,
            toType: 'document',
            toId: document.id,
          })
          return { created: 'document', documentId: document.id, title: document.title, type: document.type }
        }

        // refine_task: resolve the reference among the team's tasks only.
        const reference = action.reference?.trim()
        if (!reference) return refused('say which task to change')
        const tasks = await deps.tasks.listForTeam(ctx.workspaceId, ctx.teamId)
        const candidates: ArtefactCandidate[] = tasks.map((task) => ({
          kind: 'task',
          id: task.id,
          key: task.key,
          title: task.title,
        }))
        const resolution = resolveArtefactReference(reference, candidates)
        if (resolution.status === 'none') {
          return refused(`no task here matches "${reference}"`)
        }
        if (resolution.status === 'ambiguous') {
          return ask([
            {
              id: 'task',
              about: 'task',
              question: `Which task did you mean by "${reference}"?`,
              choices: resolution.candidates.map((c) => ({ id: c.id, label: `${c.key} ${c.title}` })),
            },
          ])
        }

        const target = tasks.find((task) => task.id === resolution.match.id)!
        const additions = (action.acceptanceCriteria ?? []).map((text) => ({ text, checked: false }))
        if (additions.length === 0) return refused('say what to add to the task')
        await deps.tasks.update({
          workspaceId: ctx.workspaceId,
          taskId: target.id,
          actorId: ctx.actor.userId,
          changes: { acceptanceCriteria: [...target.acceptanceCriteria, ...additions] },
        })
        return { refined: 'task', taskId: target.id, key: target.key }
      },
    },
  ]
}
