import type { EdgeCandidate, EntityCandidate } from '@chorus/core'
import type { EntityStore } from './entities.js'

/**
 * Resolving an extraction batch into the graph (BRAIN-3 AC3).
 *
 * The policy that keeps the graph honest: a candidate that matches an existing
 * entity *confidently* is merged into it automatically; one that matches only
 * plausibly becomes a `merge` review item — a proposal, never a silent merge —
 * because an automatic merge that is wrong is very hard to notice and very
 * annoying to undo. One that matches nothing is simply a new entity.
 */

/** At or above this trigram similarity, two entities are taken to be the same thing. */
export const MERGE_THRESHOLD = 0.85
/** Between the floor and the threshold, a match is proposed for review rather than applied. */
export const REVIEW_FLOOR = 0.4

export interface ExtractionBatch {
  readonly signalId: string
  readonly extractorVersion: number
  readonly entities: readonly EntityCandidate[]
  readonly edges: readonly EdgeCandidate[]
}

export interface IngestOutcome {
  readonly merged: number
  readonly created: number
  readonly reviewItems: number
  readonly edges: number
}

export interface ExtractionIngestor {
  ingest(workspaceId: string, batch: ExtractionBatch): Promise<IngestOutcome>
}

export function createExtractionIngestor(store: EntityStore): ExtractionIngestor {
  return {
    async ingest(workspaceId, batch) {
      let merged = 0
      let created = 0
      let reviewItems = 0
      let edges = 0

      // Where each candidate's external id ended up — the existing entity it
      // merged into, or the new one it became — so edges can resolve endpoints.
      const resolved = new Map<string, string>()

      for (const candidate of batch.entities) {
        const match = await store.resolveByName({
          workspaceId,
          kind: candidate.kind,
          name: candidate.name,
          excludeExternalId: candidate.externalId,
        })

        if (match && match.score >= MERGE_THRESHOLD) {
          // Confident: the same thing. Attach the new evidence and aliases to
          // the entity that already exists rather than making a second.
          await store.attach({
            workspaceId,
            entityId: match.entityId,
            aliases: [candidate.name, ...(candidate.aliases ?? [])],
            signalId: batch.signalId,
            extractorVersion: batch.extractorVersion,
          })
          resolved.set(candidate.externalId, match.entityId)
          merged += 1
          continue
        }

        // Not confident enough to merge: the candidate becomes its own entity.
        const { entityId, created: wasCreated } = await store.upsertCandidate({
          workspaceId,
          candidate,
          signalId: batch.signalId,
          extractorVersion: batch.extractorVersion,
        })
        resolved.set(candidate.externalId, entityId)
        if (wasCreated) created += 1

        // A plausible-but-sub-threshold match is proposed, not applied (AC3).
        if (match && match.score >= REVIEW_FLOOR) {
          await store.openReviewItem({
            workspaceId,
            kind: 'merge',
            subject: {
              proposed: { entityId, name: candidate.name, externalId: candidate.externalId },
              existing: { entityId: match.entityId, name: match.name },
              score: match.score,
              evidence: { signalId: batch.signalId },
            },
          })
          reviewItems += 1
        }
      }

      for (const edge of batch.edges) {
        const from = resolved.get(edge.fromExternalId) ?? (await store.findByExternalId(workspaceId, edge.fromExternalId))
        const to = resolved.get(edge.toExternalId) ?? (await store.findByExternalId(workspaceId, edge.toExternalId))
        if (!from || !to) continue
        await store.addEdge({
          workspaceId,
          fromEntityId: from,
          toEntityId: to,
          kind: edge.kind,
          confidence: edge.confidence,
          signalId: batch.signalId,
          extractorVersion: batch.extractorVersion,
        })
        edges += 1
      }

      return { merged, created, reviewItems, edges }
    },
  }
}
