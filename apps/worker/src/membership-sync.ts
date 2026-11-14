import { withTenant, type DbConfig } from '@chorus/db'
import type { ConfluenceConnector, ConnectorContext } from '@chorus/connectors'
import type { ScopeMemberships } from '@chorus/brain'

/**
 * Confluence group membership becomes access (NFR-4 AC1, AND1).
 *
 * A Confluence page restricted to a group is captured onto its signal as
 * `confluence:group:<name>`, and retrieval shows it only to someone holding that
 * scope. This decides who holds it. The groups read are exactly the ones
 * restricted pages name — no others matter. Each person who linked their own
 * Atlassian account (ADR-0024) is granted the groups that account is in, plus
 * `confluence:user:<accountId>` for pages restricted to them by name. A group
 * member who never linked gains nothing: there is no email fallback.
 *
 * A page with no restriction of its own is scoped to its space
 * (`confluence:space:<id>`); its readers are the space's — users granted `read`
 * on the space directly, and the members of groups granted it. A principal that
 * cannot be resolved to people (a role) grants nobody, and is counted so the gap
 * is visible rather than guessed at.
 *
 * Every group and space is read *before* anything is written. A sync that cannot read one
 * group has half a picture, and acting on it would revoke access people still
 * have or keep access they lost; so it throws and changes nothing, and the next
 * sync tries again.
 *
 * It lives in the worker for the reason extraction does: the group directory is
 * the connector's, the memberships are the brain's, and this is where they meet.
 */

export interface MembershipSyncOutcome {
  /** Groups named by restricted pages, and read from Confluence. */
  readonly groups: number
  /** Spaces that space-scoped pages belong to, and whose readers were read. */
  readonly spaces: number
  /** Space read grants to principals that resolve to nobody here (e.g. roles). */
  readonly unresolvedPrincipals: number
  /** People with a linked Atlassian account whose Confluence scopes were set. */
  readonly linkedPeople: number
  /** People who held Confluence scopes without a linked account, and lost them. */
  readonly unlinkedRevoked: number
}

export interface MembershipSync {
  sync(ctx: ConnectorContext): Promise<MembershipSyncOutcome>
}

const GROUP_PREFIX = 'confluence:group:'
const SPACE_PREFIX = 'confluence:space:'
const USER_PREFIX = 'confluence:user:'

export function createConfluenceMembershipSync(deps: {
  readonly config: DbConfig
  readonly connector: Pick<ConfluenceConnector, 'groupMembers' | 'groupMembersById' | 'spaceReaders'>
  readonly memberships: ScopeMemberships
}): MembershipSync {
  return {
    async sync(ctx) {
      const { groups, spaces, linked, holders } = await withTenant(
        ctx.workspaceId,
        async (t) => {
          const scopesLike = (prefix: string) =>
            t.query<{ scope: string }>(
              `SELECT DISTINCT scope
                 FROM signals s, jsonb_array_elements_text(s.permissions->'scopeIds') AS scope
                WHERE s.integration_id = $1 AND scope LIKE $2
                  -- Only what current versions are restricted to (BRAIN-1 AC3).
                  AND NOT EXISTS (SELECT 1 FROM signals newer WHERE newer.supersedes_id = s.id)
                ORDER BY scope`,
              [ctx.integrationId, `${prefix}%`],
            )
          const groupRows = await scopesLike(GROUP_PREFIX)
          const spaceRows = await scopesLike(SPACE_PREFIX)
          const linkedRows = await t.query<{ user_id: string; account_id: string }>(
            `SELECT user_id, account_id FROM linked_accounts WHERE provider = 'atlassian' ORDER BY user_id`,
          )
          const holderRows = await t.query<{ user_id: string }>(
            `SELECT DISTINCT user_id FROM source_scope_memberships WHERE source = 'confluence'`,
          )
          return {
            groups: groupRows.map((r) => r.scope.slice(GROUP_PREFIX.length)),
            spaces: spaceRows.map((r) => r.scope.slice(SPACE_PREFIX.length)),
            linked: linkedRows,
            holders: holderRows.map((r) => r.user_id),
          }
        },
        { config: deps.config },
      )

      // Read every group and space first. Any failure throws here, before a single write.
      const membersOf = new Map<string, Set<string>>()
      for (const group of groups) {
        const members = await deps.connector.groupMembers(group, ctx)
        membersOf.set(group, new Set(members.map((m) => m.accountId)))
      }
      const readersOf = new Map<string, Set<string>>()
      const membersById = new Map<string, Set<string>>()
      let unresolvedPrincipals = 0
      for (const space of spaces) {
        const readers = await deps.connector.spaceReaders(space, ctx)
        unresolvedPrincipals += readers.unresolvedPrincipals
        const accounts = new Set(readers.accountIds)
        for (const groupId of [...readers.groupIds].sort()) {
          if (!membersById.has(groupId)) {
            const members = await deps.connector.groupMembersById(groupId, ctx)
            membersById.set(groupId, new Set(members.map((m) => m.accountId)))
          }
          for (const accountId of membersById.get(groupId)!) accounts.add(accountId)
        }
        readersOf.set(space, accounts)
      }

      const actor = { type: 'integration' as const, id: ctx.integrationId }
      for (const { user_id: userId, account_id: accountId } of linked) {
        const scopeIds = [
          ...groups.filter((group) => membersOf.get(group)?.has(accountId)).map((group) => `${GROUP_PREFIX}${group}`),
          ...spaces.filter((space) => readersOf.get(space)?.has(accountId)).map((space) => `${SPACE_PREFIX}${space}`),
          `${USER_PREFIX}${accountId}`,
        ]
        await deps.memberships.replace({
          workspaceId: ctx.workspaceId,
          userId,
          source: 'confluence',
          scopeIds,
          actor,
        })
      }

      // Anyone still holding Confluence scopes without a linked account loses them.
      // Unlinking already revokes at once; this keeps the table honest regardless.
      const linkedUsers = new Set(linked.map((l) => l.user_id))
      const orphaned = holders.filter((userId) => !linkedUsers.has(userId))
      for (const userId of orphaned) {
        await deps.memberships.replace({ workspaceId: ctx.workspaceId, userId, source: 'confluence', scopeIds: [], actor })
      }

      return {
        groups: groups.length,
        spaces: spaces.length,
        unresolvedPrincipals,
        linkedPeople: linked.length,
        unlinkedRevoked: orphaned.length,
      }
    },
  }
}
