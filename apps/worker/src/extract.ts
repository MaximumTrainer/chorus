import type { Signal } from '@chorus/core'
import { withTenant, type DbConfig } from '@chorus/db'
import type { Connector } from '@chorus/connectors'
import type { EntityStore } from '@chorus/brain'

/**
 * The deterministic extraction pass (BRAIN-3, architecture.md §10.3).
 *
 * The first of the two passes, and the one that needs no model: entities the
 * source already defines — a tracker issue is a `ticket`, a chat user a
 * `person` — are read straight out of the signal by the connector's
 * `mapExternal` and landed in the entity store. No model is called (AC1); there
 * is nothing to infer, so a model would be slower and less accurate than
 * reading the field.
 *
 * It lives here, not in `packages/brain`, for the dependency reason the sink
 * dispatcher does: the mapping is the connector's, and the runtime may not
 * import `@chorus/connectors`. The store is the brain's; the connectors are the
 * worker's; this is where they meet.
 */

export interface DeterministicExtractor {
  extract(workspaceId: string): Promise<{ readonly signals: number; readonly entities: number }>
}

interface SignalRow {
  readonly id: string
  readonly source: string
  readonly external_id: string
  readonly kind: string
  readonly text: string | null
  readonly structured: unknown
  readonly author: string | null
  readonly author_display: string | null
  readonly occurred_at: Date
  readonly url: string | null
  readonly permissions: Signal['permissions']
  readonly raw: unknown
}

/** Rebuild the in-memory Signal a connector's `mapExternal` reads from its row. */
function toSignal(row: SignalRow): Signal {
  return {
    source: row.source as Signal['source'],
    externalId: row.external_id,
    kind: row.kind,
    text: row.text,
    structured: row.structured,
    author: row.author ? { externalId: row.author, display: row.author_display ?? row.author } : null,
    occurredAt: row.occurred_at,
    url: row.url,
    permissions: row.permissions,
    raw: row.raw,
  }
}

export function createDeterministicExtractor(deps: {
  readonly config: DbConfig
  /** The connectors that can map, by source kind — their `mapExternal` is pure. */
  readonly connectorsByKind: Readonly<Record<string, () => Connector>>
  readonly entities: EntityStore
  readonly extractorVersion?: number
}): DeterministicExtractor {
  const version = deps.extractorVersion ?? 1

  return {
    async extract(workspaceId) {
      const rows = await withTenant(
        workspaceId,
        (t) =>
          t.query<SignalRow>(
            `SELECT id, source, external_id, kind, text, structured, author, author_display,
                    occurred_at, url, permissions, raw
               FROM signals ORDER BY ingested_at`,
          ),
        { config: deps.config },
      )

      let entities = 0
      for (const row of rows) {
        const connector = deps.connectorsByKind[row.source]?.()
        if (!connector?.mapExternal) continue
        const candidates = connector.mapExternal(toSignal(row))
        for (const candidate of candidates) {
          await deps.entities.upsertCandidate({
            workspaceId,
            candidate,
            signalId: row.id,
            extractorVersion: version,
          })
          entities += 1
        }
      }
      return { signals: rows.length, entities }
    },
  }
}
