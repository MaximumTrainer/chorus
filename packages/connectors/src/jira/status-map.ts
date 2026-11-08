import { TransitionError, ValidationError } from '@chorus/core'

/**
 * INT-8 AC5 — Jira status mapping, validated and never guessed.
 *
 * Jira's workflow statuses differ per project and a Chorus status has no
 * canonical Jira equivalent, so the mapping is explicit configuration. The
 * rule is that an unknown is surfaced, never guessed: a map entry pointing at a
 * status the project does not have is caught at save time, and at push time an
 * unmapped Chorus status blocks the write with a message naming it rather than
 * moving the issue to a "closest" status nobody chose.
 */

/** One Jira transition available from an issue's current status. */
export interface JiraTransition {
  readonly id: string
  readonly name: string
  readonly to: { readonly name: string }
}

/** A Chorus status → Jira workflow-status-name map, keyed by Chorus status. */
export type StatusMap = Readonly<Record<string, string>>

/** A map entry whose Jira status is not one the project actually has. */
export interface StatusMapProblem {
  readonly chorusStatus: string
  readonly jiraStatus: string
}

/**
 * The map entries that point at a Jira status the project does not have, for
 * the save-time check (AC5). An empty array means the map is valid. Matching is
 * case-insensitive because Jira status names are presented inconsistently and a
 * casing difference is not a real mismatch.
 */
export function validateStatusMap(
  map: StatusMap,
  projectStatuses: readonly string[],
): StatusMapProblem[] {
  const known = new Set(projectStatuses.map((name) => name.toLowerCase()))
  return Object.entries(map)
    .filter(([, jiraStatus]) => !known.has(jiraStatus.toLowerCase()))
    .map(([chorusStatus, jiraStatus]) => ({ chorusStatus, jiraStatus }))
}

/**
 * The Jira status a Chorus status maps to, or a `ValidationError` naming the
 * Chorus status. This is the "never guessed" guarantee: an unmapped status
 * blocks the push rather than resolving to something nobody configured.
 */
export function requireMapping(chorusStatus: string, map: StatusMap): string {
  const target = map[chorusStatus]
  if (!target) {
    throw new ValidationError(
      `No Jira status is mapped for the Chorus status "${chorusStatus}". Add it to this project's status map before syncing.`,
      { chorusStatus, mapped: Object.keys(map) },
    )
  }
  return target
}

/**
 * The transition that moves an issue to `jiraStatus`, or a `TransitionError`
 * when Jira offers no such move from the issue's current status — an illegal
 * transition, not an excuse to pick a different target.
 */
export function requireTransition(
  jiraStatus: string,
  available: readonly JiraTransition[],
): JiraTransition {
  const match = available.find((t) => t.to.name.toLowerCase() === jiraStatus.toLowerCase())
  if (!match) {
    throw new TransitionError(
      `Jira has no available transition to "${jiraStatus}" from the issue's current status.`,
      { jiraStatus, available: available.map((t) => t.to.name) },
    )
  }
  return match
}
