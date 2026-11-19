import { ValidationError } from './errors.js'

/**
 * Retention (NFR-4 AC3, WS-7 AC4, architecture.md §20).
 *
 * How long each class of captured data is kept before the worker's purge
 * removes it. A class with no period is kept: deleting by default is the one
 * choice that cannot be undone, so the defaults are an owner's decision
 * (plan.md D-10), not ours.
 *
 * Only classes Chorus actually holds are named. A setting for transcripts or
 * screenshots before anything stores them would be a control that does
 * nothing, and an owner who set it would believe something was being purged.
 *
 * - `prompts` — the prompt and response bodies inside a run's model calls. The
 *   call's structural record (model, tokens, cost, hashes) is kept.
 * - `run_traces` — a run's trace events. The run itself, and the spend ledger
 *   that its cost is reconciled against, are kept.
 */
export const RETENTION_CLASSES = ['prompts', 'run_traces'] as const

export type RetentionClass = (typeof RETENTION_CLASSES)[number]

export function isRetentionClass(value: unknown): value is RetentionClass {
  return typeof value === 'string' && (RETENTION_CLASSES as readonly string[]).includes(value)
}

/** Ten years. Longer is "keep", which `null` already says without a magic number. */
export const MAX_RETENTION_DAYS = 3650

/**
 * A period in whole days, or `null` to keep the class indefinitely.
 *
 * Refused rather than coerced: a string "30" or a fraction is a caller that
 * has misunderstood the field, and guessing what they meant on a setting that
 * deletes data is the wrong side to err on.
 */
export function parseRetentionDays(value: unknown): number | null {
  if (value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_RETENTION_DAYS
  ) {
    throw new ValidationError(
      `days must be a whole number from 1 to ${MAX_RETENTION_DAYS}, or null to keep indefinitely`,
      { field: 'days' },
    )
  }
  return value
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Data captured before this moment is past its period. */
export function retentionCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS)
}
