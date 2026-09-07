/**
 * Emitting an artefact (AGENT-1, architecture.md §11.7).
 *
 * Declared in `core` because a feature package may only reach another through a
 * `core` interface: the agent runtime emits, the API stores, and neither
 * imports the other.
 *
 * > the emit step validates that every pointer resolves to a real file at a
 * > real commit before an artefact is written.
 *
 * That sentence is the contract, and it runs the right way round: **validation
 * happens before the write, not after**. An artefact written first and checked
 * later has already been seen, linked to and acted on by the time anybody
 * notices it is wrong — and a model that produced one plausible-looking
 * citation will produce more.
 */

import { z } from 'zod'

export const ARTEFACT_KINDS = ['document', 'task'] as const
export type ArtefactKind = (typeof ARTEFACT_KINDS)[number]

export function isArtefactKind(value: unknown): value is ArtefactKind {
  return typeof value === 'string' && (ARTEFACT_KINDS as readonly string[]).includes(value)
}

/** A code citation an artefact claims. Checked before the artefact is written. */
export interface ArtefactPointer {
  readonly repositoryId: string
  readonly path: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly symbolName?: string
}

/**
 * What a workflow proposes to write.
 *
 * Deliberately narrow. A workflow describes an artefact in the vocabulary of
 * the product — a title, sections, criteria — and the writer decides how that
 * becomes rows. Letting a workflow hand over a partial database record would
 * make every schema change a workflow change.
 */
export interface ArtefactDraft {
  readonly kind: ArtefactKind
  readonly title: string
  /** For a document: section key to content. Ignored for a task. */
  readonly sections?: Readonly<Record<string, string>>
  /** For a task: its acceptance criteria, in order. */
  readonly acceptanceCriteria?: readonly string[]
  readonly tags?: readonly string[]
  /** Citations the artefact makes. Every one is resolved before writing. */
  readonly pointers?: readonly ArtefactPointer[]
  /** The document type, when the kind is `document`. */
  readonly documentType?: string
}

export interface EmittedArtefact {
  readonly kind: ArtefactKind
  readonly id: string
  readonly title: string
  /** Pointers that were written — never more than were validated. */
  readonly pointerCount: number
}

export interface ArtefactContext {
  readonly workspaceId: string
  readonly teamId: string
  readonly runId: string
  readonly actorId: string
}

export interface ArtefactWriter {
  emit(draft: ArtefactDraft, context: ArtefactContext): Promise<EmittedArtefact>
}

/**
 * A draft that could not be written, and why.
 *
 * A distinct error rather than a generic one so a run's trace says *this
 * artefact was refused* rather than *the run failed*, which are different
 * things to somebody reading it later.
 */
export class ArtefactRefusedError extends Error {
  override readonly name = 'ArtefactRefusedError'
  // Assigned in the body rather than declared as a constructor parameter
  // property: Node runs this package's TypeScript by stripping types, and a
  // parameter property is the one TypeScript construct that emits code rather
  // than erasing. The browser-journey harness imports this file directly.
  readonly details: Readonly<Record<string, unknown>>

  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.details = details
  }
}

/**
 * The wire shape of an `ArtefactDraft`, as a schema (CLAUDE.md §10).
 *
 * A model asked for an artefact is asked for *this*, and the same definition
 * validates what comes back — so "the shape the prompt requested" and "the
 * shape the code accepts" cannot drift apart, which they silently did while the
 * request was prose and the acceptance was a brace-scraper.
 *
 * `title` is required and non-empty for the reason the old parser also checked
 * it: everything downstream names the artefact by it, and a document titled
 * from the first line of a model's preamble is worse than no document.
 */
export const ArtefactPointerSchema = z.object({
  repositoryId: z.string(),
  path: z.string(),
  lineStart: z.number().int(),
  lineEnd: z.number().int(),
  symbolName: z.string().optional(),
})

export const ArtefactDraftSchema = z.object({
  /**
   * Optional, because the workflow already knows it.
   *
   * An emit step names the artefact it is writing (`artefact: prd`), and the
   * kind follows from that. Requiring the model to repeat it would ask for a
   * fact the run already holds and let a wrong answer contradict it.
   */
  kind: z.enum(ARTEFACT_KINDS).optional(),
  title: z.string().min(1, 'an artefact needs a title'),
  sections: z.record(z.string(), z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  pointers: z.array(ArtefactPointerSchema).optional(),
  documentType: z.string().optional(),
})

/**
 * Schemas a prompt may name in its `outputSchema` front-matter (§9.4).
 *
 * A registry rather than a free-form schema in the prompt file: a prompt is
 * text, and a schema expressed as text would be a second definition of a shape
 * `core` already owns. Naming one keeps the single definition single.
 */
export const OUTPUT_SCHEMAS = {
  artefact_draft: ArtefactDraftSchema,
} as const

export type OutputSchemaName = keyof typeof OUTPUT_SCHEMAS

export function isOutputSchemaName(value: unknown): value is OutputSchemaName {
  return typeof value === 'string' && value in OUTPUT_SCHEMAS
}
