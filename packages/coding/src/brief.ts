import { createHash } from 'node:crypto'

/**
 * The one brief builder (CODE-2, architecture.md §12.1).
 *
 * > One deterministic builder produces both `BRIEF.md` (for the agent to read)
 * > and `brief.json` (for adapters that prefer structure) … The same builder
 * > serves the MCP `implement-task` prompt, so a local agent and the platform's
 * > sandbox receive **identical** context.
 *
 * This file is assembly only: it takes gathered inputs and returns text. The
 * gathering lives next door, and the split is what makes determinism and
 * truncation testable without a database — the two properties most likely to
 * rot, and the two least likely to be noticed rotting.
 */

export interface BriefConventions {
  readonly packageManager: string | null
  readonly testCommand: string | null
  readonly lintCommand: string | null
  readonly formatCommand: string | null
  readonly buildCommand: string | null
  readonly contributionGuide: string | null
  readonly agentInstructions: readonly string[]
  readonly monorepo: readonly string[] | null
}

export interface BriefPointer {
  readonly path: string
  readonly symbolName: string | null
  readonly lineStart: number
  readonly lineEnd: number
  readonly commitSha: string | null
  readonly source: string
  /** Marked, not dropped (AC5): the agent is told, rather than misled. */
  readonly stale: boolean
}

export interface BriefDocument {
  readonly title: string
  readonly documentType: string
  /** Section key to content, in the order the document declares them. */
  readonly sections: ReadonlyArray<{ readonly key: string; readonly body: string }>
}

export interface BriefDecision {
  readonly at: string
  readonly text: string
}

export interface BriefCapture {
  readonly kind: string
  readonly note: string
}

export interface BriefTask {
  readonly key: string
  readonly title: string
  readonly description: string
  readonly acceptanceCriteria: readonly string[]
  readonly tags: readonly string[]
}

export interface BriefInputs {
  readonly charter: string
  readonly repositoryFullName: string
  readonly baseBranch: string
  readonly conventions: BriefConventions
  readonly documents: readonly BriefDocument[]
  readonly decisions: readonly BriefDecision[]
  readonly captures: readonly BriefCapture[]
  readonly task: BriefTask
  readonly pointers: readonly BriefPointer[]
}

export interface BriefJson extends BriefInputs {
  /** What the budget forced out, named rather than silently dropped (AC4). */
  readonly omitted: readonly string[]
}

export interface Brief {
  readonly markdown: string
  readonly json: BriefJson
  /** SHA-256 of the Markdown. Stable for unchanged inputs (AC3). */
  readonly hash: string
}

/**
 * The default size budget, in characters of Markdown.
 *
 * A brief is the front of an agent's context and everything it reads afterwards
 * competes with it. Generous enough that a real task never truncates, small
 * enough that a pathological document cannot crowd out the criteria.
 */
export const DEFAULT_BUDGET_CHARS = 60_000

/**
 * What may be truncated, in the order it goes (AC4).
 *
 * Criteria and pointers are absent from this list on purpose. They are the two
 * things the agent is being asked to satisfy and the two places it is being
 * told to look; a brief that dropped either would still look complete and would
 * send the agent to the wrong files to satisfy the wrong requirement.
 */
const TRUNCATION_ORDER = ['captures', 'decisions', 'documents', 'charter'] as const

function heading(title: string, body: string): string {
  return `## ${title}\n\n${body.trim()}\n`
}

function conventionsSection(conventions: BriefConventions): string {
  const lines: string[] = []
  // The exact commands, quoted (AC6). An agent that has to guess between
  // `npm test` and `pnpm run test` guesses wrong in a container with no
  // network, and reports a failure that is its own rather than the code's.
  if (conventions.packageManager) lines.push(`- Package manager: \`${conventions.packageManager}\``)
  if (conventions.testCommand) lines.push(`- Tests: \`${conventions.testCommand}\``)
  if (conventions.lintCommand) lines.push(`- Lint: \`${conventions.lintCommand}\``)
  if (conventions.formatCommand) lines.push(`- Format: \`${conventions.formatCommand}\``)
  if (conventions.buildCommand) lines.push(`- Build: \`${conventions.buildCommand}\``)
  if (conventions.contributionGuide) {
    lines.push(`- Contribution guide: \`${conventions.contributionGuide}\``)
  }
  for (const instruction of conventions.agentInstructions) {
    lines.push(`- House rules, read before editing: \`${instruction}\``)
  }
  if (conventions.monorepo && conventions.monorepo.length > 0) {
    lines.push(`- Monorepo workspaces: ${conventions.monorepo.map((g) => `\`${g}\``).join(', ')}`)
  }
  return lines.length > 0
    ? lines.join('\n')
    : '_None detected. Ask before assuming a command._'
}

function documentsSection(documents: readonly BriefDocument[]): string {
  if (documents.length === 0) return '_No linked documents._'
  return documents
    .map((document) => {
      const sections = document.sections
        .map((section) => `### ${section.key}\n\n${section.body.trim()}`)
        .join('\n\n')
      return `### ${document.title} (${document.documentType})\n\n${sections}`
    })
    .join('\n\n')
}

function pointersSection(pointers: readonly BriefPointer[]): string {
  if (pointers.length === 0) return '_No code pointers. Find the relevant files yourself._'
  return pointers
    .map((pointer) => {
      const where = `\`${pointer.path}\`:${pointer.lineStart}-${pointer.lineEnd}`
      const symbol = pointer.symbolName ? ` — \`${pointer.symbolName}\`` : ''
      // Flagged in the text an agent actually reads, not only in the JSON an
      // adapter might parse. A stale pointer presented as fact is worse than no
      // pointer: the agent goes to the line, finds something else, and reasons
      // from it.
      const stale = pointer.stale
        ? ' — **stale**: the index has changed since this was recorded, so verify before trusting it'
        : ''
      return `- ${where}${symbol}${stale}`
    })
    .join('\n')
}

function taskSection(task: BriefTask): string {
  const criteria =
    task.acceptanceCriteria.length > 0
      ? task.acceptanceCriteria.map((text) => `- [ ] ${text}`).join('\n')
      : '_No acceptance criteria recorded._'
  const tags = task.tags.length > 0 ? `\n\nTags: ${task.tags.join(', ')}` : ''
  return `### ${task.key} — ${task.title}\n\n${task.description.trim()}${tags}\n\n#### Acceptance criteria\n\n${criteria}`
}

function render(inputs: BriefInputs, omitted: readonly string[]): string {
  const parts: string[] = ['# Brief\n']

  // Ordered stable-first for provider prefix caching (§9.3): the charter and
  // the repository's conventions change on the scale of months, the task and
  // its pointers on the scale of minutes. Caching is a prefix match, so the
  // volatile half has to be last or nothing before it can be reused.
  if (!omitted.includes('charter') && inputs.charter.trim() !== '') {
    parts.push(heading('Team charter', inputs.charter))
  }
  parts.push(
    heading(
      'Repository',
      `- Repository: \`${inputs.repositoryFullName}\`\n- Branch from: \`${inputs.baseBranch}\`\n${conventionsSection(inputs.conventions)}`,
    ),
  )
  if (!omitted.includes('documents')) {
    parts.push(heading('Source documents', documentsSection(inputs.documents)))
  }
  if (!omitted.includes('decisions')) {
    parts.push(
      heading(
        'Decisions',
        inputs.decisions.length === 0
          ? '_No decisions recorded for this task._'
          : inputs.decisions.map((d) => `- ${d.at}: ${d.text}`).join('\n'),
      ),
    )
  }
  if (!omitted.includes('captures')) {
    parts.push(
      heading(
        'Capture evidence',
        inputs.captures.length === 0
          ? '_No capture evidence._'
          : inputs.captures.map((c) => `- ${c.kind}: ${c.note}`).join('\n'),
      ),
    )
  }
  parts.push(heading('Task', taskSection(inputs.task)))
  parts.push(heading('Code pointers', pointersSection(inputs.pointers)))

  if (omitted.length > 0) {
    // Disclosed, not silent (AC4). An agent working from a brief that quietly
    // lost a section produces work that is wrong for a reason nobody can see
    // in the output.
    parts.push(
      heading(
        'Omitted',
        `The following were left out to fit the size budget, in order of lowest priority first: ${omitted.join(', ')}. Ask if you need them.`,
      ),
    )
  }

  return parts.join('\n')
}

/**
 * Assembles a brief, truncating by precedence if it must (AC3, AC4).
 *
 * Deterministic: the same inputs produce the same bytes, so the hash means
 * something to a cache and to a trace. Nothing here reads a clock, and the
 * gatherer orders every query, because a brief whose sections shuffled between
 * two identical runs would make every hash comparison a false negative.
 */
export function assembleBrief(
  inputs: BriefInputs,
  options: { readonly budgetChars?: number } = {},
): Brief {
  const budget = options.budgetChars ?? DEFAULT_BUDGET_CHARS

  const omitted: string[] = []
  let markdown = render(inputs, omitted)

  // Dropped whole rather than cut mid-sentence: half a document reads as a
  // complete one that happens to stop, and an agent cannot tell that it is
  // missing the paragraph that mattered.
  for (const section of TRUNCATION_ORDER) {
    if (markdown.length <= budget) break
    omitted.push(section)
    markdown = render(inputs, omitted)
  }

  return {
    markdown,
    json: { ...inputs, omitted },
    hash: createHash('sha256').update(markdown, 'utf8').digest('hex'),
  }
}
