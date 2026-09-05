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
