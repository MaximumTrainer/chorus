import { NotFoundError } from '@chorus/core'
import { withTenant, type DbConfig } from '@chorus/db'
import {
  assembleBrief,
  type Brief,
  type BriefConventions,
  type BriefDocument,
  type BriefPointer,
} from './brief.js'

/**
 * Gathers what a brief is made of, and hands it to the one assembler (CODE-2).
 *
 * Every query is ordered. That is not tidiness: AC3 requires a brief to be
 * byte-identical for unchanged inputs, and Postgres makes no promise about row
 * order without an `ORDER BY` — so an unordered query produces a brief that is
 * usually stable and occasionally is not, which is the worst possible version
 * of a hash that is supposed to mean something.
 */

export interface BriefBuilder {
  /** The brief, in both forms, plus its hash. */
  forTask(workspaceId: string, taskId: string): Promise<Brief>
  /** What is written to `BRIEF.md` in a sandbox job. */
  forSandbox(workspaceId: string, taskId: string): Promise<string>
  /** What the MCP `implement-task` prompt returns (MCP-4). */
  forMcpPrompt(workspaceId: string, taskId: string): Promise<string>
}

interface TaskRow {
  key: string
  title: string
  description: unknown
  acceptance_criteria: unknown
  tags: string[] | null
  team_id: string
}

const EMPTY_CONVENTIONS: BriefConventions = {
  packageManager: null,
  testCommand: null,
  lintCommand: null,
  formatCommand: null,
  buildCommand: null,
  contributionGuide: null,
  agentInstructions: [],
  monorepo: null,
}

/**
 * The description, as text.
 *
 * Stored as the editor's document model rather than as markup, so a brief has
 * to flatten it. Unknown node shapes contribute nothing rather than throwing: a
 * brief missing a paragraph is recoverable, a brief that could not be built
 * because somebody used a new block type is not.
 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n\n')
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    return Object.values(record).map(textOf).filter(Boolean).join('\n\n')
  }
  return ''
}

function criteriaOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry
      if (entry !== null && typeof entry === 'object') {
        const text = (entry as Record<string, unknown>).text
        return typeof text === 'string' ? text : ''
      }
      return ''
    })
    .filter((text) => text !== '')
}

function conventionsOf(settings: unknown): BriefConventions {
  const raw =
    settings !== null && typeof settings === 'object'
      ? ((settings as Record<string, unknown>).conventions as Record<string, unknown> | undefined)
      : undefined
  if (!raw) return EMPTY_CONVENTIONS

  const string = (key: string): string | null =>
    typeof raw[key] === 'string' ? (raw[key] as string) : null

  return {
    packageManager: string('packageManager'),
    testCommand: string('testCommand'),
    lintCommand: string('lintCommand'),
    formatCommand: string('formatCommand'),
    buildCommand: string('buildCommand'),
    contributionGuide: string('contributionGuide'),
    agentInstructions: Array.isArray(raw.agentInstructions)
      ? (raw.agentInstructions as unknown[]).filter((v): v is string => typeof v === 'string')
      : [],
    monorepo: Array.isArray(raw.monorepo)
      ? (raw.monorepo as unknown[]).filter((v): v is string => typeof v === 'string')
      : null,
  }
}

/**
 * A document's sections, in the order the template declares them.
 *
 * Order is preserved rather than sorted: the template's sequence is the
 * argument the document is making, and re-ordering it would hand the agent a
 * rearranged case for the work. It is already an array, so the order is
 * deterministic without any help (AC3).
 *
 * Empty sections are dropped. A heading with nothing under it tells the agent
 * only that somebody had intended to write something.
 */
function sectionsOf(sections: unknown): BriefDocument['sections'] {
  if (!Array.isArray(sections)) return []
  return sections
    .map((section) => {
      if (section === null || typeof section !== 'object') return { key: '', body: '' }
      const record = section as Record<string, unknown>
      const key = typeof record.title === 'string' && record.title !== ''
        ? record.title
        : typeof record.key === 'string'
          ? record.key
          : ''
      return { key, body: textOf(record.content) }
    })
    .filter((section) => section.key !== '' && section.body !== '')
}

export function createBriefBuilder(config: DbConfig): BriefBuilder {
  async function build(workspaceId: string, taskId: string): Promise<Brief> {
    return withTenant(
      workspaceId,
      async (t) => {
        const [task] = await t.query<TaskRow>(
          `SELECT key, title, description, acceptance_criteria, tags, team_id
             FROM tasks WHERE id = $1 AND deleted_at IS NULL`,
          [taskId],
        )
        if (!task) {
          throw new NotFoundError(`Task "${taskId}" does not exist, so no brief can be built.`, {
            taskId,
          })
        }

        const [team] = await t.query<{ charter: string | null }>(
          `SELECT charter FROM teams WHERE id = $1`,
          [task.team_id],
        )

        // The repository the agent will branch from. Ordered and limited so a
        // team with two linked repositories produces a stable brief rather than
        // whichever row came back first.
        const [repository] = await t.query<{
          full_name: string
          base_branch: string
          settings: unknown
        }>(
          `SELECT full_name, base_branch, settings
             FROM repositories
            WHERE team_id = $1 AND deleted_at IS NULL
            ORDER BY created_at, id
            LIMIT 1`,
          [task.team_id],
        )

        const documents = await t.query<{
          title: string
          type: string
          sections: unknown
        }>(
          `SELECT d.title, d.type, d.sections
             FROM artefact_links l
             JOIN documents d ON d.id = l.to_id AND d.workspace_id = l.workspace_id
            WHERE l.from_type = 'task' AND l.from_id = $1 AND l.to_type = 'document'
              AND d.deleted_at IS NULL
            ORDER BY d.created_at, d.id`,
          [taskId],
        )

        const pointers = await t.query<{
          path: string
          symbol_name: string | null
          line_start: number
          line_end: number
          commit_sha: string | null
          source: string
          stale_at: Date | null
        }>(
          `SELECT path, symbol_name, line_start, line_end, commit_sha, source, stale_at
             FROM code_pointers
            WHERE task_id = $1
            ORDER BY path, line_start, line_end`,
          [taskId],
        )

        return assembleBrief({
          charter: team?.charter ?? '',
          repositoryFullName: repository?.full_name ?? 'unknown',
          baseBranch: repository?.base_branch ?? 'main',
          conventions: conventionsOf(repository?.settings),
          documents: documents.map((document) => ({
            title: document.title,
            documentType: document.type,
            sections: sectionsOf(document.sections),
          })),
          // CHAT-10 and EXT-5 are not built. Present and empty rather than
          // absent, so an adapter never has to tell "no decisions" apart from
          // "this builder forgot decisions" — and so wiring them up later is an
          // addition here rather than a change to the brief's shape.
          decisions: [],
          captures: [],
          task: {
            key: task.key,
            title: task.title,
            description: textOf(task.description),
            acceptanceCriteria: criteriaOf(task.acceptance_criteria),
            tags: task.tags ?? [],
          },
          pointers: pointers.map(
            (pointer): BriefPointer => ({
              path: pointer.path,
              symbolName: pointer.symbol_name,
              lineStart: pointer.line_start,
              lineEnd: pointer.line_end,
              commitSha: pointer.commit_sha,
              source: pointer.source,
              stale: pointer.stale_at !== null,
            }),
          ),
        })
      },
      { config },
    )
  }

  return {
    forTask: build,
    // Both of these are the same bytes, deliberately and by construction rather
    // than by two code paths that happen to agree today (AC2). A second
    // renderer here is exactly the drift the acceptance test exists to catch.
    async forSandbox(workspaceId, taskId) {
      return (await build(workspaceId, taskId)).markdown
    },
    async forMcpPrompt(workspaceId, taskId) {
      return (await build(workspaceId, taskId)).markdown
    },
  }
}
