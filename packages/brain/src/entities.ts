import {
  ulid,
  ValidationError,
  isExternalAuthorityKind,
  parseExternalUri,
  type EntityCandidate,
} from '@chorus/core'
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
  /**
   * An external-authority entity whose name or an alias matches, or null
   * (BRAIN-11 AC2). Exact, case-insensitive: the extractor links to the owning
   * graph's entity only when it is clearly the same thing, never on a fuzzy
   * match that could point a reference at the wrong service.
   */
  findExternalByName(
    workspaceId: string,
    name: string,
  ): Promise<{ readonly entityId: string; readonly externalUri: string } | null>
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
  /**
   * Every review item in a workspace, open or decided, for a detector's own
   * deduplication: a decided item is the team's recorded correction, so a
   * detector must not resurface what was already ruled on — a rejection sticks
   * (BRAIN-7 AC6).
   */
  allReviewItems(
    workspaceId: string,
  ): Promise<
    readonly { readonly id: string; readonly kind: string; readonly status: string; readonly subject: Record<string, unknown> }[]
  >
  /** One review item by id, or null. */
  reviewItem(
    workspaceId: string,
    itemId: string,
  ): Promise<{ readonly id: string; readonly kind: string; readonly status: string; readonly subject: Record<string, unknown> } | null>
  /**
   * Consolidates `loserId` into `winnerId` in one transaction (BRAIN-7 AC2):
   * the loser's aliases, edges and evidence move to the winner, the loser's
   * name becomes an alias, and the loser is deleted — leaving no dangling
   * reference. Idempotent: merging an already-gone loser is a no-op.
   */
  mergeEntities(input: {
    readonly workspaceId: string
    readonly winnerId: string
    readonly loserId: string
  }): Promise<void>
  /**
   * Decides a review item, applying its effect and clearing it (NAV-3 AC3).
   * Accepting a `merge` consolidates the two entities; any decision records
   * who made it and closes the item. A no-op if it is already decided.
   */
  decideReviewItem(input: {
    readonly workspaceId: string
    readonly itemId: string
    readonly decision: 'accept' | 'reject'
    readonly decidedBy?: string
  }): Promise<{ readonly applied: boolean; readonly decided: boolean }>
  /** The entity with this external id, or null. */
  findByExternalId(workspaceId: string, externalId: string): Promise<string | null>
  /**
   * Removes an external-authority entity because its owning source emitted a
   * tombstone (BRAIN-11 AC8). The entity and its edges — and its evidence and
   * aliases, by cascade — are deleted; an `artefact_links` row pointing at it
   * from either end is marked `dangling` rather than deleted, so a task or
   * document that referenced it keeps its pointer and a reader sees the
   * reference went away rather than it silently vanishing. A tombstone for an
   * entity already gone is a no-op (idempotent, for a duplicate feed delivery);
   * one aimed at a brain-authored entity is refused, because a source feed owns
   * only what it authored.
   */
  tombstoneExternal(input: {
    readonly workspaceId: string
    readonly externalId: string
  }): Promise<{ readonly removed: boolean; readonly danglingLinks: number }>
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

/**
 * Consolidates `loserId` into `winnerId` within one transaction (BRAIN-7 AC2).
 *
 * A free function on the tenant transaction, so both `mergeEntities` and a
 * `decideReviewItem` that accepts a merge run it in the *same* transaction as
 * their own writes — the consolidation and the decision commit together or not
 * at all, which is what makes "no dangling reference" a guarantee rather than a
 * hope. Repoint the loser's edges, evidence and aliases to the winner, dropping
 * the ones that would collide, then delete the loser.
 */
async function mergeWithinTx(
  t: TenantTx,
  workspaceId: string,
  winnerId: string,
  loserId: string,
): Promise<void> {
  if (winnerId === loserId) return
  const [loser] = await t.query<{ name: string }>(`SELECT name FROM entities WHERE id = $1`, [loserId])
  if (!loser) return // already merged away — idempotent

  // Edges: drop the loser's that, once repointed, self-loop or duplicate an
  // edge not itself involving the loser, then repoint the rest — so no repoint
  // violates the (from, to, kind) uniqueness.
  await t.execute(
    `DELETE FROM entity_edges e
      WHERE (e.from_entity_id = $2 OR e.to_entity_id = $2)
        AND (
          (CASE WHEN e.from_entity_id = $2 THEN $1 ELSE e.from_entity_id END)
          = (CASE WHEN e.to_entity_id = $2 THEN $1 ELSE e.to_entity_id END)
          OR EXISTS (
            SELECT 1 FROM entity_edges w
             WHERE w.from_entity_id <> $2 AND w.to_entity_id <> $2
               AND w.kind = e.kind
               AND w.from_entity_id = (CASE WHEN e.from_entity_id = $2 THEN $1 ELSE e.from_entity_id END)
               AND w.to_entity_id   = (CASE WHEN e.to_entity_id   = $2 THEN $1 ELSE e.to_entity_id   END)
          )
        )`,
    [winnerId, loserId],
  )
  await t.execute(`UPDATE entity_edges SET from_entity_id = $1 WHERE from_entity_id = $2`, [winnerId, loserId])
  await t.execute(`UPDATE entity_edges SET to_entity_id = $1 WHERE to_entity_id = $2`, [winnerId, loserId])

  // Evidence: drop the loser's rows that collide with the winner's, repoint the rest.
  await t.execute(
    `DELETE FROM entity_evidence l
      WHERE l.entity_id = $2
        AND EXISTS (
          SELECT 1 FROM entity_evidence w
           WHERE w.entity_id = $1 AND w.signal_id = l.signal_id AND w.extractor_version = l.extractor_version
        )`,
    [winnerId, loserId],
  )
  await t.execute(`UPDATE entity_evidence SET entity_id = $1 WHERE entity_id = $2`, [winnerId, loserId])

  // Aliases: the loser's name becomes an alias, then its own aliases move over.
  await t.execute(
    `INSERT INTO entity_aliases (id, workspace_id, entity_id, alias)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, entity_id, lower(alias)) DO NOTHING`,
    [ulid(), workspaceId, winnerId, loser.name],
  )
  await t.execute(
    `DELETE FROM entity_aliases l
      WHERE l.entity_id = $2
        AND EXISTS (SELECT 1 FROM entity_aliases w WHERE w.entity_id = $1 AND lower(w.alias) = lower(l.alias))`,
    [winnerId, loserId],
  )
  await t.execute(`UPDATE entity_aliases SET entity_id = $1 WHERE entity_id = $2`, [winnerId, loserId])

  await t.execute(`DELETE FROM entities WHERE id = $1`, [loserId])
}

export function createEntityStore(config: DbConfig): EntityStore {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>) =>
    withTenant(workspaceId, fn, { config })

  return {
    async upsertCandidate({ workspaceId, candidate, signalId, extractorVersion }) {
      // An operational kind is a reference to an external system, so it must
      // declare external authority and a parseable uri; refuse a brain-authored
      // one here with a typed error rather than letting the database reject it
      // with a message nobody can read (BRAIN-11 AC1).
      if (isExternalAuthorityKind(candidate.kind) && candidate.authority !== 'external') {
        throw new ValidationError(`a ${candidate.kind} is a reference to an external system and must declare external authority`, {
          kind: candidate.kind,
        })
      }
      const external = candidate.authority === 'external'
      if (external && (!candidate.externalUri || parseExternalUri(candidate.externalUri) === null)) {
        throw new ValidationError('an external-authority entity needs a parseable externalUri', {
          kind: candidate.kind,
          externalUri: candidate.externalUri ?? null,
        })
      }
      const authority = external ? 'external' : 'brain'
      const externalUri = external ? candidate.externalUri! : null

      return tx(workspaceId, async (t) => {
        // `xmax = 0` is true only for the row this statement inserted, so one
        // round trip tells us whether the entity is new or was already there —
        // which is what distinguishes a first extraction from a re-run.
        const [row] = await t.query<{ id: string; created: boolean }>(
          `INSERT INTO entities
             (id, workspace_id, kind, external_id, name, attributes, extractor_version, authority, external_uri, last_synced_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, CASE WHEN $8 = 'external' THEN now() ELSE NULL END)
           ON CONFLICT (workspace_id, external_id) DO UPDATE
             SET name = EXCLUDED.name,
                 attributes = EXCLUDED.attributes,
                 extractor_version = EXCLUDED.extractor_version,
                 authority = EXCLUDED.authority,
                 external_uri = EXCLUDED.external_uri,
                 last_synced_at = CASE WHEN EXCLUDED.authority = 'external' THEN now() ELSE entities.last_synced_at END,
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
            authority,
            externalUri,
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
          `INSERT INTO entity_evidence
             (id, workspace_id, entity_id, signal_id, char_start, char_end, extractor_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (workspace_id, entity_id, signal_id, extractor_version) DO NOTHING`,
          [
            ulid(),
            workspaceId,
            entityId,
            signalId,
            candidate.evidence.charStart ?? null,
            candidate.evidence.charEnd ?? null,
            extractorVersion,
          ],
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

    async tombstoneExternal({ workspaceId, externalId }) {
      return tx(workspaceId, async (t) => {
        const [found] = await t.query<{ id: string; authority: string }>(
          `SELECT id, authority FROM entities WHERE external_id = $1`,
          [externalId],
        )
        // A tombstone for something already gone is a no-op — a feed may deliver
        // the same event twice, and the second delivery must not error.
        if (!found) return { removed: false, danglingLinks: 0 }
        // A source feed owns only what it authored; it may not remove a
        // brain-authored entity by claiming it was tombstoned upstream.
        if (found.authority !== 'external') {
          throw new ValidationError(
            `entity ${externalId} is brain-authored; a source feed may not tombstone it`,
          )
        }

        // Links pointing at it, from either end, are kept but marked dangling —
        // the referencing task or document keeps its pointer (AC8).
        const dangled = await t.query<{ id: string }>(
          `UPDATE artefact_links
              SET state = 'dangling'
            WHERE ((to_type = 'entity' AND to_id = $1) OR (from_type = 'entity' AND from_id = $1))
              AND state <> 'dangling'
            RETURNING id`,
          [found.id],
        )

        // The entity goes, and its edges, evidence and aliases with it (cascade).
        await t.execute(`DELETE FROM entities WHERE id = $1`, [found.id])
        return { removed: true, danglingLinks: dangled.length }
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

    async findExternalByName(workspaceId, name) {
      return tx(workspaceId, async (t) => {
        const [row] = await t.query<{ id: string; external_uri: string }>(
          `SELECT e.id, e.external_uri
             FROM entities e
            WHERE e.authority = 'external'
              AND (lower(e.name) = lower($1)
                   OR EXISTS (SELECT 1 FROM entity_aliases a
                               WHERE a.entity_id = e.id AND lower(a.alias) = lower($1)))
            ORDER BY e.created_at
            LIMIT 1`,
          [name],
        )
        return row ? { entityId: row.id, externalUri: row.external_uri } : null
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

    async allReviewItems(workspaceId) {
      return tx(workspaceId, (t) =>
        t.query<{ id: string; kind: string; status: string; subject: Record<string, unknown> }>(
          `SELECT id, kind, status, subject FROM brain_review_items ORDER BY created_at DESC`,
        ),
      )
    },

    async reviewItem(workspaceId, itemId) {
      return tx(workspaceId, async (t) => {
        const [row] = await t.query<{
          id: string
          kind: string
          status: string
          subject: Record<string, unknown>
        }>(`SELECT id, kind, status, subject FROM brain_review_items WHERE id = $1`, [itemId])
        return row ?? null
      })
    },

    async mergeEntities({ workspaceId, winnerId, loserId }) {
      if (winnerId === loserId) return
      await tx(workspaceId, (t) => mergeWithinTx(t, workspaceId, winnerId, loserId))
    },

    async decideReviewItem({ workspaceId, itemId, decision, decidedBy }) {
      return tx(workspaceId, async (t) => {
        const [item] = await t.query<{ kind: string; status: string; subject: Record<string, unknown> }>(
          `SELECT kind, status, subject FROM brain_review_items WHERE id = $1`,
          [itemId],
        )
        if (!item || item.status !== 'open') return { applied: false, decided: false }

        let applied = false
        if (decision === 'accept' && item.kind === 'merge') {
          // Tolerant of both shapes: BRAIN-3's ingestor writes {proposed, existing},
          // BRAIN-7's detector writes {winner, loser}. The existing entity wins.
          const subject = item.subject as {
            winner?: { entityId?: string }
            loser?: { entityId?: string }
            existing?: { entityId?: string }
            proposed?: { entityId?: string }
          }
          const winnerId = subject.winner?.entityId ?? subject.existing?.entityId
          const loserId = subject.loser?.entityId ?? subject.proposed?.entityId
          if (winnerId && loserId && winnerId !== loserId) {
            await mergeWithinTx(t, workspaceId, winnerId, loserId)
            applied = true
          }
        }

        await t.execute(
          `UPDATE brain_review_items
              SET status = $2, decided_by = $3, decided_at = now()
            WHERE id = $1`,
          [itemId, decision === 'accept' ? 'accepted' : 'rejected', decidedBy ?? null],
        )
        return { applied, decided: true }
      })
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
