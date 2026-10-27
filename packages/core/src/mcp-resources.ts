import { documentToMarkdown } from './document-body.js'
import type { TaskRecord } from './tasks.js'

/**
 * The MCP resources and prompts (MCP-4, architecture.md §14).
 *
 * A resource lets an agent pin an artefact as context without a tool call per
 * read. It is Markdown with front-matter, and the front-matter carries what an
 * agent needs to cite the artefact without asking again: its id, its kind, its
 * canonical URL and when it last changed (AC1).
 *
 * `chorus://wiki/{slug}` is not here. It arrives with BRAIN-5 (plan.md §2.3),
 * and until then it is absent rather than resolving to nothing: an agent must
 * be able to trust that an advertised resource has content.
 */

export const MCP_RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'chorus://task/{id}',
    name: 'task',
    title: 'A task',
    description:
      'One task as Markdown: its title, description, tags and acceptance criteria as a checklist, ' +
      'under front-matter giving its id, key, status and canonical URL.',
    mimeType: 'text/markdown',
  },
  {
    uriTemplate: 'chorus://doc/{id}',
    name: 'document',
    title: 'A document',
    description:
      'One document (a PRD, spec, decision record and the like) as Markdown, exactly as its ' +
      'export renders it, under front-matter giving its id, type, status and canonical URL.',
    mimeType: 'text/markdown',
  },
] as const

export type McpResourceKind = 'task' | 'doc'

/** The artefact a resource URI names, or undefined for one this server does not serve. */
export function parseResourceUri(uri: string): { kind: McpResourceKind; id: string } | undefined {
  const match = /^chorus:\/\/(task|doc)\/([^/?#]+)$/.exec(uri)
  if (!match) return undefined
  let id: string
  try {
    id = decodeURIComponent(match[2]!)
  } catch {
    return undefined
  }
  return id === '' ? undefined : { kind: match[1] as McpResourceKind, id }
}

export function resourceUri(kind: McpResourceKind, id: string): string {
  return `chorus://${kind}/${encodeURIComponent(id)}`
}

/** A front-matter field: an identifier or timestamp we generated, or free text somebody typed. */
export type FrontMatterField = readonly [key: string, value: string, kind: 'plain' | 'text']

/**
 * YAML front-matter for a resource.
 *
 * Values we generate (ids, URLs, timestamps) are written plain. Free text is
 * written as a JSON string, which YAML reads as a double-quoted scalar, so a
 * title containing a colon or a newline cannot be read as a second key.
 */
export function withFrontMatter(fields: readonly FrontMatterField[], body: string): string {
  const lines = fields.map(
    ([key, value, kind]) => `${key}: ${kind === 'text' ? JSON.stringify(value) : value}`,
  )
  return `---\n${lines.join('\n')}\n---\n\n${body}`
}

/**
 * A task's body, as Markdown.
 *
 * The description is the editor's document model, rendered by the shared
 * serialiser (DOC-7) so a task reads the same here as everywhere else.
 */
export function taskToMarkdown(task: TaskRecord): string {
  const description =
    (task.description as { type?: unknown }).type === 'doc'
      ? documentToMarkdown(task.description).trim()
      : ''
  const criteria = task.acceptanceCriteria
    .map((criterion) => `- [${criterion.checked ? 'x' : ' '}] ${criterion.text}`)
    .join('\n')
  return [
    `# ${task.key} — ${task.title}`,
    description,
    task.tags.length > 0 ? `Tags: ${task.tags.join(', ')}` : '',
    `## Acceptance criteria\n\n${criteria || '_None yet._'}`,
  ]
    .filter((part) => part !== '')
    .join('\n\n')
    .concat('\n')
}

export interface McpPromptArgument {
  readonly name: string
  readonly description: string
  readonly required: boolean
}

export interface McpPromptDefinition {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly arguments: readonly McpPromptArgument[]
}

const TASK_ID = {
  name: 'taskId',
  description: 'The task, by id. list_tasks or a chorus://task resource gives it.',
  required: true,
} as const

export const MCP_PROMPTS: readonly McpPromptDefinition[] = [
  {
    name: 'implement-task',
    title: 'Implement a task',
    description:
      'The brief for implementing one task: the same brief a Chorus coding sandbox is given, ' +
      'with its acceptance criteria, code pointers, the documents it came from and the ' +
      "repository's conventions. Work from it, and call report_pr when you open the pull request.",
    arguments: [TASK_ID],
  },
  {
    name: 'review-spec',
    title: 'Review a spec',
    description:
      'Asks for a critical review of a document (a PRD or a spec) before work is planned from ' +
      'it: what is ambiguous, missing or contradictory, and what cannot be tested as written.',
    arguments: [
      {
        name: 'documentId',
        description: 'The document to review, by id. list_documents gives it.',
        required: true,
      },
    ],
  },
  {
    name: 'write-tests-for-task',
    title: 'Write tests for a task',
    description:
      "Asks for tests that prove a task's acceptance criteria, one behaviour per test and named " +
      'after the task, written before the implementation so they fail first.',
    arguments: [TASK_ID],
  },
]

/** The required arguments a prompt call is missing, by name. */
export function missingPromptArguments(
  prompt: McpPromptDefinition,
  args: Readonly<Record<string, string | undefined>> | undefined,
): string[] {
  return prompt.arguments
    .filter((argument) => argument.required && !(args?.[argument.name] ?? '').trim())
    .map((argument) => argument.name)
}
