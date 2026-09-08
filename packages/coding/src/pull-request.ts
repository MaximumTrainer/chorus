/**
 * The pull request a coding job opens (CODE-5).
 *
 * > The pull request is where a human meets the agent's work, and its body is
 * > the entire briefing that reviewer gets. Criteria as a checklist means
 * > review has a definition of done rather than an impression.
 *
 * Which is why this is a deliberate template rather than a summary the model
 * wrote about itself. The reviewer needs to know what was asked for, what the
 * agent claims it did, and whether the repository's own checks agree — and to
 * be able to tell those three apart.
 */

export interface PullRequestFacts {
  readonly taskKey: string
  readonly taskTitle: string
  readonly taskUrl: string
  /** The document the task came from, where there is one. */
  readonly documentUrl?: string | undefined
  /** Where the exact brief this job ran from can be read. */
  readonly briefUrl: string
  readonly acceptanceCriteria: readonly string[]
  readonly summary: string
  readonly testOutput: string
  readonly lintOutput: string
  readonly adapter: string
  readonly requestedBy: string
}

/** `CH-1: Split the invoice parser` — findable from the tracker by key. */
export function pullRequestTitle(facts: PullRequestFacts): string {
  return `${facts.taskKey}: ${facts.taskTitle}`
}

/**
 * A results block, or an explicit statement that it did not run.
 *
 * The distinction matters more than it looks. An omitted section reads as
 * "tests passed and nobody mentioned it"; a reviewer has to be able to tell
 * green from unrun, because only one of them is evidence.
 */
function results(label: string, output: string): string {
  if (output.trim() === '') {
    return `### ${label}\n\n_The ${label.toLowerCase()} command did not run._\n`
  }
  return `### ${label}\n\n\`\`\`\n${output.trim()}\n\`\`\`\n`
}

export function pullRequestBody(facts: PullRequestFacts): string {
  const criteria =
    facts.acceptanceCriteria.length > 0
      ? facts.acceptanceCriteria.map((text) => `- [ ] ${text}`).join('\n')
      : // An empty checklist reads as "nothing to check". Saying there were
        // none tells the reviewer they are judging without a definition of
        // done, which is a different and more useful thing to know.
        '_This task recorded no acceptance criteria, so there is no agreed definition of done to check against._'

  const links = [
    `- Task: [${facts.taskKey} — ${facts.taskTitle}](${facts.taskUrl})`,
    ...(facts.documentUrl ? [`- Source document: [the document this came from](${facts.documentUrl})`] : []),
    `- Brief: [what the agent was given](${facts.briefUrl})`,
  ].join('\n')

  return [
    // Said first and plainly. A reviewer reads a machine-written diff
    // differently from a colleague's, and is entitled to know which this is
    // before forming an opinion of it.
    `> Opened by the Chorus \`${facts.adapter}\` coding agent, at the request of ${facts.requestedBy}.`,
    '',
    links,
    '',
    '## Acceptance criteria',
    '',
    criteria,
    '',
    '## What the agent says it did',
    '',
    facts.summary.trim() === '' ? '_The agent produced no summary._' : facts.summary.trim(),
    '',
    '## Checks',
    '',
    results('Tests', facts.testOutput),
    results('Lint', facts.lintOutput),
  ].join('\n')
}
