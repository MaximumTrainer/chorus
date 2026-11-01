import { ulid, type EntityCandidate } from '@chorus/core'
import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * The entity store — persisting what extraction found (BRAIN-3).
 *
 * The deterministic pass reads entities the source already defines and lands
 * them here. Identity is the source's own namespaced id, so two signals about
 * one issue resolve to one entity rather than growing one per mention, and
 * re-extracting the same signals at the same version is a no-op (AC4) — the
 * uniqueness is the database's, not a check-then-insert that races a sync.
 *
 * Every entity keeps its evidence: the signal it was read from, which must lead
 * back to the source text (AC2). An entity with no evidence cannot be
 * re-derived when an extractor version changes, nor explained to someone asking
 * why the brain believes it.
 */

export interface StoredEntity {
  readonly id: string
  readonly kind: string
  readonly externalId: string
  readonly name: string
}

export interface UpsertResult {
  readonly entityId: string
  /** True when this call created the entity, false when it matched an existing one. */
  readonly created: boolean
}

export interface EntityStore {
  /**
   * Resolves a candidate to an entity by its external id, creating it when new
   * and refreshing its name and attributes when it already exists, then records
   * its aliases and the evidence for this extraction. Idempotent per
   * (entity, signal, extractor version).
   */
  upsertCandidate(input: {
    readonly workspaceId: string
    readonly candidate: EntityCandidate
    readonly signalId: string
    readonly extractorVersion: number
  }): Promise<UpsertResult>
  /** The entities in a workspace, for a reader or a test. */
  list(workspaceId: string): Promise<readonly StoredEntity[]>
  /** The signal ids that justify an entity (BRAIN-3 AC2). */
  evidenceFor(workspaceId: string, entityId: string): Promise<readonly string[]>
}

export function createEntityStore(config: DbConfig): EntityStore {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>) =>
    withTenant(workspaceId, fn, { config })

  return {
    async upsertCandidate({ workspaceId, candidate, signalId, extractorVersion }) {
      return tx(workspaceId, async (t) => {
        // `xmax = 0` is true only for the row this statement inserted, so one
        // round trip tells us whether the entity is new or was already there —
        // which is what distinguishes a first extraction from a re-run.
        const [row] = await t.query<{ id: string; created: boolean }>(
          `INSERT INTO entities (id, workspace_id, kind, external_id, name, attributes, extractor_version)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
           ON CONFLICT (workspace_id, external_id) DO UPDATE
             SET name = EXCLUDED.name,
                 attributes = EXCLUDED.attributes,
                 extractor_version = EXCLUDED.extractor_version,
                 updated_at = now()
           RETURNING id, (xmax = 0) AS created`,
          [
            ulid(),
            workspaceId,
            candidate.kind,
            candidate.externalId,
            candidate.name,
            JSON.stringify(candidate.attributes ?? {}),
            extractorVersion,
          ],
        )
        const entityId = row!.id

        for (const alias of candidate.aliases ?? []) {
          if (alias.trim() === '') continue
          await t.execute(
            `INSERT INTO entity_aliases (id, workspace_id, entity_id, alias)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (workspace_id, entity_id, lower(alias)) DO NOTHING`,
            [ulid(), workspaceId, entityId, alias],
          )
        }

        await t.execute(
          `INSERT INTO entity_evidence (id, workspace_id, entity_id, signal_id, extractor_version)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (workspace_id, entity_id, signal_id, extractor_version) DO NOTHING`,
          [ulid(), workspaceId, entityId, signalId, extractorVersion],
        )

        return { entityId, created: row!.created }
      })
    },

    async list(workspaceId) {
      return tx(workspaceId, (t) =>
        t.query<StoredEntity>(
          `SELECT id, kind, external_id AS "externalId", name FROM entities ORDER BY created_at`,
        ),
      )
    },

    async evidenceFor(workspaceId, entityId) {
      return tx(workspaceId, async (t) => {
        const rows = await t.query<{ signal_id: string }>(
          `SELECT signal_id FROM entity_evidence WHERE entity_id = $1 ORDER BY created_at`,
          [entityId],
        )
        return rows.map((r) => r.signal_id)
      })
    },
  }
}
