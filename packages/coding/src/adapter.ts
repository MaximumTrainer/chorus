import type { Brief } from './brief.js'
import type { Sandbox, SandboxChange, SandboxSpec } from '@chorus/core'

/**
 * The coding-adapter contract (CODE-3, architecture.md §12.2).
 *
 * > Coding agents are **adapters** implementing `prepare → run → collect`.
 *
 * The shape is three phases rather than one `run` because each is a different
 * kind of failure. `prepare` fails before anything has been spent; `run` fails
 * with a container to tear down and partial output worth keeping; `collect`
 * fails with work that exists and must not silently become a pull request. A
 * single call would collapse the three into "the job failed".
 */

export interface JobContext {
  readonly jobId: string
  /** The brief, from the one builder (CODE-2). Never assembled per adapter. */
  readonly brief: Brief
  readonly spec: SandboxSpec
}

export interface PreparedJob {
  /**
   * Files to place in the working tree before the agent starts — `BRIEF.md`,
   * and whatever configuration the agent reads.
   */
  readonly files: Readonly<Record<string, string>>
  /**
   * The entrypoint, run non-interactively (AC3).
   *
   * A command rather than a shell string: a string is joined by somebody and
   * split by somebody else, and the disagreement is a shell injection.
   */
  readonly command: readonly string[]
}

/**
 * What a job emits while it runs.
 *
 * Streamed rather than returned, because a coding job takes minutes and a panel
 * that shows nothing until it finishes cannot be told apart from one that hung.
 */
export type JobEvent =
  /** A phase the reader can follow: cloning, planning, editing, testing. */
  | { readonly kind: 'step'; readonly text: string }
  /** Raw output from the agent or the commands it ran. */
  | { readonly kind: 'output'; readonly text: string }
  /** The agent used one of its tools. Shown inline, so the run is legible. */
  | { readonly kind: 'tool'; readonly tool: string; readonly summary: string }
  /** Terminal, and the reason is kept (AC5). */
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'finished' }

export interface JobResult {
  readonly diff: string
  readonly summary: string
  readonly testOutput: string
  readonly change: SandboxChange
  /** What the agent reported spending, where it reports anything. */
  readonly costCents?: number
  /** Set when the job did not produce usable work, and why (AC5). */
  readonly failure?: string
}

export interface CodingAdapter {
  /** `reference`, `claude-code`, `codex`, … (§12.2). */
  readonly id: string
  /** The sandbox base image this adapter runs in. */
  readonly image: string
  /**
   * Exactly the secrets it needs.
   *
   * Declared rather than taken, so the sandbox environment can be built as an
   * allow-list and enumerated (CODE-4 AC1). An adapter that quietly read
   * another variable would be reading a credential nobody granted it.
   */
  readonly requiredSecrets: readonly string[]

  prepare(context: JobContext): Promise<PreparedJob>
  run(prepared: PreparedJob, sandbox: Sandbox): AsyncIterable<JobEvent>
  collect(sandbox: Sandbox): Promise<JobResult>
}

/** Where the brief is written, and what every adapter's prompt points at. */
export const BRIEF_FILENAME = 'BRIEF.md'
export const BRIEF_JSON_FILENAME = 'brief.json'
