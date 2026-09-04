import { z } from 'zod'

/**
 * Documents and their templates (DOC-1, architecture.md §8.2).
 *
 * > The template is where a team's standard for "good enough to build" lives.
 * > It is also the structure the agent fills, so template quality directly
 * > determines draft quality.
 *
 * The distinction this file exists to keep is between **guidance** and
 * **content**. Guidance is advice to whoever is writing — "what problem does
 * this solve, and for whom?" — and it must never end up inside the document.
 * If it does, it becomes text an agent reads back as though somebody wrote it,
 * text that appears in an export, and text a reviewer deletes by hand before
 * the document says anything true.
 *
 * So a section carries both, separately, at every layer: in the template, in
 * the stored document and on the wire.
 */

export const DOCUMENT_TYPES = ['prd', 'spec', 'strategy', 'freeform', 'gap_spec'] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(value)
}

export const DOCUMENT_STATUSES = ['draft', 'in_review', 'approved', 'archived'] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

/**
 * One section of a template.
 *
 * `key` is stable and `title` is not: a team renaming "The problem" to
 * "Problem statement" must not orphan what people wrote under it, so content
 * is addressed by key throughout.
 */
export const TemplateSectionSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, { message: 'a section key must be lower_snake_case' }),
  title: z.string().trim().min(1).max(200),
  /** Shown to the author as a placeholder. Never saved as content. */
  guidance: z.string().max(2000).default(''),
  /**
   * Reported when missing, never enforced (AC4).
   *
   * A template is a standard, not a gate. A document somebody cannot save
   * until it is finished is a document they write somewhere else.
   */
  required: z.boolean().default(false),
})
export type TemplateSection = z.infer<typeof TemplateSectionSchema>

export const TemplateSchema = z.object({
  sections: z.array(TemplateSectionSchema).min(1).max(50),
})

/** A problem with a template, phrased for whoever is editing it. */
export interface TemplateProblem {
  readonly message: string
}

/**
 * Checks a template beyond its shape.
 *
 * Duplicate keys are the failure worth catching: content is addressed by key,
 * so two sections sharing one makes it ambiguous which a saved paragraph
 * belongs to — and the ambiguity appears later, as text that moves between
 * sections when a document is reopened.
 */
export function validateTemplate(sections: readonly TemplateSection[]): TemplateProblem[] {
  const problems: TemplateProblem[] = []
  const seen = new Set<string>()

  for (const section of sections) {
    if (seen.has(section.key)) {
      problems.push({
        message: `section key "${section.key}" is used more than once, so content addressed to it would be ambiguous`,
      })
    }
    seen.add(section.key)
  }

  return problems
}

/** A section of a document: the template's framing plus what was written. */
export interface DocumentSection {
  readonly key: string
  readonly title: string
  /** Carried for display, so the author sees the advice while writing. */
  readonly guidance: string
  readonly required: boolean
  /** What somebody actually wrote. Empty until they do. */
  readonly content: string
}

/**
 * A new document's body, from a template.
 *
 * Content starts empty — deliberately, and this is AC3. Seeding it with the
 * guidance would make an untouched document look written, and every consumer
 * downstream would treat the platform's prompts as the team's words.
 */
export function applyTemplate(sections: readonly TemplateSection[]): DocumentSection[] {
  return sections.map((section) => ({
    key: section.key,
    title: section.title,
    guidance: section.guidance,
    required: section.required,
    content: '',
  }))
}

/** Required sections with nothing written in them (AC4). */
export function missingSections(sections: readonly DocumentSection[]): string[] {
  return sections
    .filter((section) => section.required && section.content.trim() === '')
    .map((section) => section.key)
}

/**
 * Markdown for export or for a prompt.
 *
 * Headings and content only. Guidance is omitted, which is the whole of AC3 —
 * an export carrying it reads as though the author wrote the platform's
 * questions into their own document.
 */
export function toMarkdown(title: string, sections: readonly DocumentSection[]): string {
  const parts = [`# ${title}`, '']

  for (const section of sections) {
    parts.push(`## ${section.title}`, '')
    if (section.content.trim() !== '') parts.push(section.content.trim(), '')
  }

  return parts.join('\n').trimEnd() + '\n'
}

/**
 * The templates a team gets before they write their own.
 *
 * Present so a team can produce something useful on their first day rather
 * than designing five templates first. Every one of them is meant to be
 * edited: the rationale is explicit that teams must be able to change the
 * standard rather than accept the platform's opinion of it.
 */
export const DEFAULT_TEMPLATES: Readonly<Record<DocumentType, readonly TemplateSection[]>> = {
  prd: [
    { key: 'problem', title: 'Problem', guidance: 'Who has this problem, and what does it cost them today?', required: true },
    { key: 'outcome', title: 'Desired outcome', guidance: 'What is true after this ships that is not true now?', required: true },
    { key: 'scope', title: 'Scope', guidance: 'What is in, and — more usefully — what is deliberately out?', required: false },
    { key: 'risks', title: 'Risks and open questions', guidance: 'What might make this the wrong thing to build?', required: false },
  ],
  spec: [
    { key: 'summary', title: 'Summary', guidance: 'One paragraph a reviewer could repeat back accurately.', required: true },
    { key: 'behaviour', title: 'Behaviour', guidance: 'What the system does, in cases rather than adjectives.', required: true },
    { key: 'interfaces', title: 'Interfaces', guidance: 'APIs, events, schemas anybody else has to work against.', required: false },
    { key: 'testing', title: 'How it is tested', guidance: 'What would prove this works, and what would prove it does not.', required: false },
  ],
  strategy: [
    { key: 'context', title: 'Context', guidance: 'What is happening that makes this worth deciding now?', required: true },
    { key: 'bets', title: 'Bets', guidance: 'What are we choosing to believe, and what follows if we are wrong?', required: true },
    { key: 'alternatives', title: 'Alternatives considered', guidance: 'What else was on the table, and why not that?', required: false },
  ],
  freeform: [
    { key: 'body', title: 'Notes', guidance: 'Anything. This template deliberately imposes nothing.', required: false },
  ],
  gap_spec: [
    { key: 'observed', title: 'What exists today', guidance: 'The current behaviour, described without judgement.', required: true },
    { key: 'intended', title: 'What was intended', guidance: 'The behaviour the spec or the team expected.', required: true },
    { key: 'gap', title: 'The gap', guidance: 'The difference, and what it costs.', required: true },
  ],
}
