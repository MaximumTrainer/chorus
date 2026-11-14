import { createHash } from 'node:crypto'
import { NotFoundError } from '@chorus/core'
import type { DbConfig } from '@chorus/db'
import type { Job, Queue } from '@chorus/queue'
import {
  createSyncRunner,
  type ConfluenceConnector,
  type Connector,
  type ConnectorContext,
  type CredentialStore,
  type IntegrationRecord,
} from '@chorus/connectors'
import type { EntityStore, ScopeMemberships } from '@chorus/brain'
import { createDeterministicExtractor } from '../extract.js'
import { createConfluenceMembershipSync } from '../membership-sync.js'

/**
 * Running one integration's sync (BRAIN-1).
 *
 * The sync runner (INT-1) already commits each page with its cursor in one
 * transaction, validates every signal at the boundary, and refuses duplicates
 * at the database. This is what runs it: for one integration, pull what is new,
 * then extract entities from what arrived. A sync that stopped at its page
 * budget continues in a follow-up job straight away, from the persisted cursor
 * (AC5); one the source rate-limited continues after the delay the source asked
 * for. A failed sync has already recorded its health; the next scheduled tick
 * tries again, so it is not retried here as well.
 *
 * After a Confluence sync, the membership sync runs (NFR-4): the groups and
 * spaces the pages are restricted to are read, and granted to the people who
 * linked their own Atlassian account, so access follows the source on every
 * run — including losing it.
 */

export const SYNC_INTEGRATION_QUEUE = 'connector.sync'

export interface SyncIntegrationJob {
  readonly workspaceId: string
  readonly integrationId: string
}

export interface SyncIntegrationDeps {
  readonly dbConfig: DbConfig
  readonly queue: Queue
  readonly credentials: CredentialStore
  /**
   * The source connectors this worker can sync, by integration kind. Given the
   * integration, so a connector whose API base is per site (Atlassian's cloud
   * id) can build it from the integration's config; called without one where
   * only pure mapping is needed.
   */
  readonly connectors: Readonly<Record<string, (integration?: IntegrationRecord) => Connector>>
  readonly entities: EntityStore
  /** Where Confluence group and space access is recorded (NFR-4). */
  readonly memberships?: ScopeMemberships
  readonly now?: () => Date
  readonly fetch?: typeof fetch
  /** Pages one job may pull before handing on to a follow-up job. */
  readonly maxPagesPerRun?: number
}

/** A follow-up's key names where it starts, so one position is continued once. */
const positionKey = (cursor: string | null): string =>
  createHash('sha256')
    .update(cursor ?? '')
    .digest('hex')
    .slice(0, 16)

export function syncIntegrationConsumer(deps: SyncIntegrationDeps) {
  const runner = createSyncRunner(deps.dbConfig, deps.credentials, {
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.maxPagesPerRun ? { maxPagesPerRun: deps.maxPagesPerRun } : {}),
  })
  const extractor = createDeterministicExtractor({
    config: deps.dbConfig,
    connectorsByKind: deps.connectors,
    entities: deps.entities,
  })

  const now = deps.now ?? (() => new Date())
  const contextFor = async (integration: IntegrationRecord): Promise<ConnectorContext> => ({
    workspaceId: integration.workspaceId,
    integrationId: integration.id,
    credentials: await deps.credentials.credentialsFor(integration.workspaceId, integration.id),
    config: integration.config,
    now,
    fetch: deps.fetch ?? fetch,
    saveCredentials: (next) => deps.credentials.updateCredentials(integration.workspaceId, integration.id, next),
  })

  return async (job: Job<SyncIntegrationJob>): Promise<void> => {
    const { workspaceId, integrationId } = job.payload

    let integration
    try {
      integration = await deps.credentials.get(workspaceId, integrationId)
    } catch (error) {
      // Deleted since it was scheduled: nothing to sync, and nothing to retry.
      if (error instanceof NotFoundError) return
      throw error
    }
    if (integration.status === 'disconnected') return
    const create = deps.connectors[integration.kind]
    if (!create) return

    const connector = create(integration)
    const outcome = await runner.sync(workspaceId, integrationId, connector)

    if (outcome.ingested > 0) await extractor.extract(workspaceId)

    // Once caught up, not after every page batch of a backfill: each run reads
    // every restricting group and space, and the follow-up jobs would repeat it.
    if (integration.kind === 'confluence' && deps.memberships && outcome.state === 'caught_up' && isConfluence(connector)) {
      await createConfluenceMembershipSync({
        config: deps.dbConfig,
        connector,
        memberships: deps.memberships,
      }).sync(await contextFor(integration))
    }

    if (outcome.state === 'interrupted') {
      await deps.queue.enqueue(
        SYNC_INTEGRATION_QUEUE,
        { workspaceId, integrationId },
        { idempotencyKey: `sync-${integrationId}-from-${positionKey(outcome.cursor)}` },
      )
    } else if (outcome.state === 'rate_limited') {
      await deps.queue.enqueue(
        SYNC_INTEGRATION_QUEUE,
        { workspaceId, integrationId },
        {
          idempotencyKey: `sync-${integrationId}-retry-${positionKey(outcome.cursor)}`,
          delayMs: outcome.retryAfterMs ?? 60_000,
        },
      )
    }
  }
}

function isConfluence(connector: Connector): connector is ConfluenceConnector {
  return 'groupMembers' in connector && 'spaceReaders' in connector && 'groupMembersById' in connector
}
