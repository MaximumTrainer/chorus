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
  /**
   * The best existing match for a name among entities of a kind, by trigram
   * similarity, or null when nothing is close. The score is how resolution
   * decides between an automatic merge and a review item (BRAIN-3 AC3).
   */
  resolveByName(input: {
    readonly workspaceId: string
    readonly kind: string
    readonly name: string
    /** The candidate's own external id, excluded so a re-extraction is not its own match. */
    readonly excludeExternalId?: string
  }): Promise<{ readonly entityId: string; readonly name: string; readonly score: number } | null>
  /** Records an edge between two entities, idempotent per (from, to, kind). */
  addEdge(input: {
    readonly workspaceId: string
    readonly fromEntityId: string
    readonly toEntityId: string
    readonly kind: string
    readonly confidence: number
    readonly signalId?: string
    readonly extractorVersion: number
  }): Promise<void>
  /** Opens a brain review item — a proposal, never an applied change (BRAIN-3 AC3, BRAIN-7). */
  openReviewItem(input: {
    readonly workspaceId: string
    readonly kind: 'merge' | 'split' | 'stale' | 'contradiction'
    readonly subject: Record<string, unknown>
  }): Promise<string>
  /** The open review items in a workspace, for the inbox or a test. */
  reviewItems(
    workspaceId: string,
  ): Promise<readonly { readonly id: string; readonly kind: string; readonly subject: Record<string, unknown> }[]>
  /** The entity with this external id, or null. */
  findByExternalId(workspaceId: string, externalId: string): Promise<string | null>
  /**
   * Attaches a candidate's aliases and evidence to an existing entity — the
   * automatic-merge path, when resolution is confident the two are the same
   * thing (BRAIN-3 AC3). Idempotent.
   */
  attach(input: {
    readonly workspaceId: string
    readonly entityId: string
    readonly aliases: readonly string[]
    readonly signalId: string
    readonly extractorVersion: number
  }): Promise<void>
  /** The entities in a workspace, for a reader or a test. */
  list(workspaceId: string): Promise<readonly StoredEntity[]>
  /** The edges in a workspace, for a reader or a test. */
  edges(
    workspaceId: string,
  ): Promise<readonly { readonly fromEntityId: string; readonly toEntityId: string; readonly kind: string }[]>
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

    async findByExternalId(workspaceId, externalId) {
      return tx(workspaceId, async (t) => {
        const [row] = await t.query<{ id: string }>(
          `SELECT id FROM entities WHERE external_id = $1`,
          [externalId],
        )
        return row?.id ?? null
      })
    },

    async attach({ workspaceId, entityId, aliases, signalId, extractorVersion }) {
      await tx(workspaceId, async (t) => {
        for (const alias of aliases) {
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
      })
    },

    async resolveByName({ workspaceId, kind, name, excludeExternalId }) {
      return tx(workspaceId, async (t) => {
        // Trigram similarity, among entities of the same kind — a person and a
        // ticket with similar names are not candidates to be the same thing.
        const [row] = await t.query<{ id: string; name: string; score: number }>(
          `SELECT id, name, similarity(name, $2) AS score
             FROM entities
            WHERE kind = $1 AND ($3::text IS NULL OR external_id <> $3)
            ORDER BY score DESC
            LIMIT 1`,
          [kind, name, excludeExternalId ?? null],
        )
        if (!row || row.score <= 0) return null
        return { entityId: row.id, name: row.name, score: Number(row.score) }
      })
    },

    async addEdge({ workspaceId, fromEntityId, toEntityId, kind, confidence, signalId, extractorVersion }) {
      await tx(workspaceId, (t) =>
        t.execute(
          `INSERT INTO entity_edges
             (id, workspace_id, from_entity_id, to_entity_id, kind, confidence, evidence_signal_id, extractor_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (workspace_id, from_entity_id, to_entity_id, kind) DO UPDATE
             SET confidence = EXCLUDED.confidence,
                 evidence_signal_id = EXCLUDED.evidence_signal_id,
                 extractor_version = EXCLUDED.extractor_version`,
          [ulid(), workspaceId, fromEntityId, toEntityId, kind, confidence, signalId ?? null, extractorVersion],
        ),
      )
    },

    async openReviewItem({ workspaceId, kind, subject }) {
      return tx(workspaceId, async (t) => {
        const id = ulid()
        await t.execute(
          `INSERT INTO brain_review_items (id, workspace_id, kind, subject)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [id, workspaceId, kind, JSON.stringify(subject)],
        )
        return id
      })
    },

    async reviewItems(workspaceId) {
      return tx(workspaceId, (t) =>
        t.query<{ id: string; kind: string; subject: Record<string, unknown> }>(
          `SELECT id, kind, subject FROM brain_review_items
            WHERE status = 'open' ORDER BY created_at DESC`,
        ),
      )
    },

    async edges(workspaceId) {
      return tx(workspaceId, (t) =>
        t.query<{ fromEntityId: string; toEntityId: string; kind: string }>(
          `SELECT from_entity_id AS "fromEntityId", to_entity_id AS "toEntityId", kind
             FROM entity_edges ORDER BY created_at`,
        ),
      )
    },
  }
}
