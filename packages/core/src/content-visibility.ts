import type { SignalPermissions } from './signals.js'

/**
 * Whether ingested content with these permission scopes may be shown to a
 * viewer (NFR-4; the enforcement primitive INT-9 AC4 needs at retrieval).
 *
 * Public content is visible to everyone. Restricted content is visible only to a
 * viewer who shares at least one of its scope ids — a team, a group, or their
 * own id. It is **fail-closed**: a restricted item with no overlap is invisible,
 * and because a restricted signal always names at least one scope
 * (`SignalPermissionsSchema` refuses an empty list), there is no degenerate
 * "restricted but matches everyone" reading to get wrong.
 *
 * The scope ids are compared as opaque strings, so the predicate is independent
 * of where they come from — a Confluence page's `confluence:group:<name>`, a
 * Jira project's `jira:project:<id>`, a Chorus team. What populates the viewer's
 * set (their team memberships, and a mapping from their identity to the external
 * groups they belong to) is the caller's concern, not this function's.
 */
export function isVisibleTo(
  permissions: Pick<SignalPermissions, 'visibility' | 'scopeIds'>,
  viewerScopeIds: ReadonlySet<string>,
): boolean {
  if (permissions.visibility === 'public') return true
  return permissions.scopeIds.some((scopeId) => viewerScopeIds.has(scopeId))
}
