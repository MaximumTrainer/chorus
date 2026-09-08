import { atLeast, type Role } from '@chorus/core'

/**
 * Whether a coding job may launch, and if not, why not (CODE-1).
 *
 * A pure function rather than a check inside a route handler, because the same
 * verdict has to be reached by the API, the UI and the MCP tool. Three handlers
 * agreeing today is not the same as one decision: the MCP path is the one where
 * a divergence would go unnoticed longest, and it is also the one an agent uses
 * without a person watching.
 */

export interface LaunchConditions {
  readonly role: Role
  /** Whether the team has a repository the job could branch from. */
  readonly repositoryLinked: boolean
  /** The adapter asked for, or the workspace default already resolved. */
  readonly adapter: string
  readonly allowedAdapters: readonly string[]
  /** A job already queued or running for this task, if there is one. */
  readonly activeJobId?: string | undefined
  readonly taskKey: string
  readonly taskTitle: string
}

export interface LaunchVerdict {
  readonly allowed: boolean
  /** Every blocking reason, phrased for the person who has to act on it. */
  readonly reasons: readonly string[]
  /** Set when the block is an existing job, so the caller can show it. */
  readonly existingJobId?: string
}

/** The rung a launch requires. */
export const LAUNCH_ROLE: Role = 'senior_member'

/**
 * Evaluates every condition, and returns **all** the reasons it failed.
 *
 * Deliberately not short-circuiting. Somebody who links a repository, retries,
 * and is then told their adapter is not permitted has been made to do the work
 * twice for no reason other than the order the checks happened to run in.
 */
export function evaluateLaunch(conditions: LaunchConditions): LaunchVerdict {
  const reasons: string[] = []

  if (!atLeast(conditions.role, LAUNCH_ROLE)) {
    reasons.push(
      `Launching a coding job needs the ${LAUNCH_ROLE} role or above; this account is ${conditions.role}.`,
    )
  }

  if (!conditions.repositoryLinked) {
    reasons.push(
      'This team has no linked repository, so there is nothing for the agent to branch from.',
    )
  }

  if (!conditions.allowedAdapters.includes(conditions.adapter)) {
    // Naming what *is* permitted turns a refusal into an instruction. "Not
    // allowed" on its own sends the reader to a settings screen to guess.
    reasons.push(
      `The adapter "${conditions.adapter}" is not permitted in this workspace. ` +
        `Permitted: ${conditions.allowedAdapters.join(', ') || 'none'}.`,
    )
  }

  if (conditions.activeJobId !== undefined) {
    reasons.push(
      'This task already has a coding job queued or running. Cancel it before starting another.',
    )
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    ...(conditions.activeJobId !== undefined ? { existingJobId: conditions.activeJobId } : {}),
  }
}

/**
 * The maximum branch length.
 *
 * git itself allows far more, but a ref that does not fit in a terminal, a pull
 * request title or a CI job name is a ref people copy wrongly.
 */
const MAX_BRANCH_LENGTH = 100

/**
 * `chorus/<task-key>-<slug>` (CODE-5 AC1).
 *
 * A task title is free text somebody typed, and git rejects a ref containing a
 * space, `..`, `~`, `^`, `:`, `?`, `*`, `[`, a backslash, a control character,
 * a trailing dot or a trailing slash. Every one of those arrives eventually, so
 * the slug is built from what is *allowed* rather than by removing what is
 * known to be forbidden — the same reasoning as the sandbox environment.
 */
export function branchNameFor(taskKey: string, taskTitle: string): string {
  const slug = taskTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const prefix = `chorus/${taskKey}`
  if (slug === '') {
    // Nothing usable in the title — `chorus/CH-4-` is not a valid ref, and the
    // key alone identifies the task perfectly well.
    return prefix
  }

  return `${prefix}-${slug}`.slice(0, MAX_BRANCH_LENGTH).replace(/-+$/, '')
}
