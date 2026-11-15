import { z } from 'zod'
import { ulid } from '@chorus/core'
import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'
import { renderPrompt, type ModelProvider, type ModelRef, type Prompt } from '@chorus/llm'
import { createEntityStore, type EntityStore } from './entities.js'

/**
 * Self-organisation: the nightly jobs that keep the graph from degrading
 * (BRAIN-7). They **propose, never apply** — an automatic merge that is wrong
 * is very hard to notice and very annoying to undo — so each lands a review
 * item, evidenced, for a human to decide (NAV-3). This slice is the merge
 * detector; split, stale and contradiction follow.
 */

/** At or above this name similarity, two same-kind entities are proposed as the same thing. */
export const MERGE_PROPOSAL_THRESHOLD = 0.6

/** An entity with no new evidence in this many days is a candidate for staleness. */
export const STALE_AFTER_DAYS = 30
/** A signal within this many days counts as a current reference to an entity. */
export const REFERENCE_WITHIN_DAYS = 14

export interface MergeDetector {
  /** Finds likely-duplicate entities and opens a `merge` review item for each new pair. */
  detect(workspaceId: string): Promise<{ readonly proposed: number }>
}

export function createMergeDetector(
  config: DbConfig,
  options: { readonly threshold?: number } = {},
): MergeDetector {
  const threshold = options.threshold ?? MERGE_PROPOSAL_THRESHOLD
  const store: EntityStore = createEntityStore(config)
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>) =>
    withTenant(workspaceId, fn, { config })

  return {
    async detect(workspaceId) {
      // Candidate pairs: same kind, ordered so each pair is considered once,
      // similar enough by name to be worth a human's attention. Trigram, like
      // extraction's resolution, so the two agree on what "similar" means.
      const pairs = await tx(workspaceId, (t) =>
        t.query<{ a: string; a_name: string; b: string; b_name: string; score: number }>(
          // External-authority entities are excluded from both sides (BRAIN-11
          // AC3): the owning graph decides what they are, and a merge proposed
          // against one is exactly the nightly noise BRAIN-11 exists to stop.
          `SELECT x.id AS a, x.name AS a_name, y.id AS b, y.name AS b_name, similarity(x.name, y.name) AS score
             FROM entities x
             JOIN entities y ON x.kind = y.kind AND x.id < y.id
            WHERE similarity(x.name, y.name) >= $1
              AND x.authority = 'brain' AND y.authority = 'brain'
            ORDER BY score DESC`,
          [threshold],
        ),
      )

      // The pairs already proposed, so a second run does not raise the same
      // item again (the detector is scheduled and will see these entities
      // nightly until a human decides).
      const open = await store.allReviewItems(workspaceId)
      const existing = new Set(
        open
          .filter((item) => item.kind === 'merge')
          .map((item) => {
            const s = item.subject as { winner?: { entityId?: string }; loser?: { entityId?: string } }
            return [s.winner?.entityId, s.loser?.entityId].sort().join('|')
          }),
      )

      let proposed = 0
      for (const pair of pairs) {
        // The older entity (smaller id) is the winner — it has been around
        // longer, so references to it are the ones more expensive to rewrite.
        const key = [pair.a, pair.b].sort().join('|')
        if (existing.has(key)) continue
        await store.openReviewItem({
          workspaceId,
          kind: 'merge',
          subject: {
            winner: { entityId: pair.a, name: pair.a_name },
            loser: { entityId: pair.b, name: pair.b_name },
            score: Number(pair.score),
            detector: 'merge',
          },
        })
        existing.add(key)
        proposed += 1
      }
      return { proposed }
    },
  }
}

export interface StaleDetector {
  /** Flags entities with no new evidence but a current reference (BRAIN-7 AC4). */
  detect(workspaceId: string): Promise<{ readonly proposed: number }>
}

export function createStaleDetector(
  config: DbConfig,
  options: {
    readonly staleAfterDays?: number
    readonly referenceWithinDays?: number
    /** How long an external entity may go unsynced before it is stale (BRAIN-11 AC3). */
    readonly externalStaleAfterDays?: number
  } = {},
): StaleDetector {
  const staleDays = options.staleAfterDays ?? STALE_AFTER_DAYS
  const referenceDays = options.referenceWithinDays ?? REFERENCE_WITHIN_DAYS
  const externalStaleDays = options.externalStaleAfterDays ?? staleDays
  const store = createEntityStore(config)
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>) =>
    withTenant(workspaceId, fn, { config })

  return {
    async detect(workspaceId) {
      // Two freshness rules, by authority (BRAIN-11 AC3).
      //
      // Brain entities: the newest evidence is older than the staleness window
      // *and* a recent signal still mentions the entity by name. The second
      // clause is AC4's precision — an entity simply old and unreferenced is not
      // flagged, because nobody relies on it.
      //
      // External entities: an evidence age means nothing (the owning graph feeds
      // them), so the only staleness is the source's own — `last_synced_at`
      // older than the integration's expected cadence.
      const stale = await tx(workspaceId, async (t) => {
        const brain = await t.query<{ id: string; name: string; reason: string }>(
          `SELECT e.id, e.name, 'unfed' AS reason
             FROM entities e
            WHERE e.authority = 'brain'
              AND COALESCE(
                    (SELECT max(ev.created_at) FROM entity_evidence ev WHERE ev.entity_id = e.id),
                    e.created_at
                  ) < now() - ($1 || ' days')::interval
              AND EXISTS (
                SELECT 1 FROM signals s
                 WHERE s.ingested_at > now() - ($2 || ' days')::interval
                   AND s.text ILIKE '%' || e.name || '%'
              )`,
          [String(staleDays), String(referenceDays)],
        )
        const external = await t.query<{ id: string; name: string; reason: string }>(
          `SELECT e.id, e.name, 'unsynced' AS reason
             FROM entities e
            WHERE e.authority = 'external'
              AND e.last_synced_at IS NOT NULL
              AND e.last_synced_at < now() - ($1 || ' days')::interval`,
          [String(externalStaleDays)],
        )
        return [...brain, ...external]
      })

      const open = await store.allReviewItems(workspaceId)
      const already = new Set(
        open
          .filter((item) => item.kind === 'stale')
          .map((item) => (item.subject as { entity?: { entityId?: string } }).entity?.entityId),
      )

      let proposed = 0
      for (const entity of stale) {
        if (already.has(entity.id)) continue
        await store.openReviewItem({
          workspaceId,
          kind: 'stale',
          subject: {
            entity: { entityId: entity.id, name: entity.name },
            detector: entity.reason === 'unsynced' ? 'external-freshness' : 'stale',
          },
        })
        proposed += 1
      }
      return { proposed }
    },
  }
}

/** The strict shape the contradiction pass returns — pairs of signal ids that conflict. */
export const ContradictionOutputSchema = z.object({
  contradictions: z
    .array(
      z.object({
        aSignalExternalId: z.string().min(1),
        bSignalExternalId: z.string().min(1),
        reason: z.string().default(''),
      }),
    )
    .default([]),
})

export interface ContradictionDetector {
  /** Surfaces conflicting claims about one entity as a review item showing both (BRAIN-7 AC5). */
  detect(workspaceId: string): Promise<{ readonly proposed: number }>
}

interface ClaimRow {
  readonly entity_id: string
  readonly name: string
  readonly signal_external_id: string
  readonly text: string
  readonly url: string | null
}

export function createContradictionDetector(deps: {
  readonly config: DbConfig
  readonly models: ModelProvider
  readonly modelFor: (tier: string) => ModelRef
  readonly prompt: Prompt
  readonly priceFor?: (model: ModelRef, usage: { inputTokens: number; outputTokens: number }) => number
}): ContradictionDetector {
  const store = createEntityStore(deps.config)
  const model = deps.modelFor('fast')
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>) =>
    withTenant(workspaceId, fn, { config: deps.config })

  return {
    async detect(workspaceId) {
      // Co-located claims only (per the impl note): the texts of the signals
      // that evidence one entity. Contradiction detection is the most expensive
      // and least reliable of the four, so it is scoped tightly and tuned for
      // precision rather than run over the whole corpus.
      const rows = await tx(workspaceId, (t) =>
        t.query<ClaimRow>(
          // Only brain-authored entities (BRAIN-11 AC3): a contradiction between
          // the external graph's claims is the graph's to resolve, not ours.
          `SELECT e.id AS entity_id, e.name, s.external_id AS signal_external_id, s.text, s.url
             FROM entities e
             JOIN entity_evidence ev ON ev.entity_id = e.id
             JOIN signals s ON s.id = ev.signal_id AND s.text IS NOT NULL AND s.text <> ''
              -- Current versions only (BRAIN-1 AC3): two drafts of one page are not a
              -- contradiction, nor two clusters.
              AND NOT EXISTS (SELECT 1 FROM signals newer WHERE newer.supersedes_id = s.id)
            WHERE e.authority = 'brain'
            ORDER BY e.id, s.external_id`,
        ),
      )

      // Group claims per entity, de-duplicating by signal.
      const byEntity = new Map<string, { name: string; claims: Map<string, ClaimRow> }>()
      for (const row of rows) {
        const entry = byEntity.get(row.entity_id) ?? { name: row.name, claims: new Map() }
        entry.claims.set(row.signal_external_id, row)
        byEntity.set(row.entity_id, entry)
      }

      const open = await store.allReviewItems(workspaceId)
      const already = new Set(
        open
          .filter((item) => item.kind === 'contradiction')
          .map((item) => {
            const s = item.subject as {
              entity?: { entityId?: string }
              claimA?: { signalExternalId?: string }
              claimB?: { signalExternalId?: string }
            }
            return [s.entity?.entityId, [s.claimA?.signalExternalId, s.claimB?.signalExternalId].sort().join('~')].join('|')
          }),
      )

      let proposed = 0
      for (const [entityId, entry] of byEntity) {
        if (entry.claims.size < 2) continue
        const claims = [...entry.claims.values()]
        const { value, usage } = await deps.models.generate({
          model,
          messages: [
            {
              role: 'user',
              content: renderPrompt(deps.prompt, {
                entity: entry.name,
                claims: claims.map((c) => `[${c.signal_external_id}] ${c.text}`).join('\n'),
              }),
            },
          ],
          context: { workspaceId, teamId: '', purpose: 'classify' },
          schema: ContradictionOutputSchema,
          schemaName: 'contradiction',
        })

        const costCents = deps.priceFor
          ? deps.priceFor(model, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })
          : 0
        await tx(workspaceId, (t) =>
          t.execute(
            `INSERT INTO spend_ledger
               (id, workspace_id, provider, model, purpose, tokens_in, tokens_cached_in, tokens_out, cost_cents)
             VALUES ($1, $2, $3, $4, 'classify', $5, $6, $7, $8)`,
            [ulid(), workspaceId, model.provider, model.model, usage.inputTokens, usage.cachedInputTokens ?? 0, usage.outputTokens, costCents],
          ),
        )

        for (const c of value.contradictions) {
          const a = entry.claims.get(c.aSignalExternalId)
          const b = entry.claims.get(c.bSignalExternalId)
          // Only pairs the model drew from the claims it was given — a
          // hallucinated id names no real source and cannot be shown.
          if (!a || !b || a.signal_external_id === b.signal_external_id) continue
          const key = [entityId, [a.signal_external_id, b.signal_external_id].sort().join('~')].join('|')
          if (already.has(key)) continue
          await store.openReviewItem({
            workspaceId,
            kind: 'contradiction',
            subject: {
              entity: { entityId, name: entry.name },
              claimA: { signalExternalId: a.signal_external_id, text: a.text, url: a.url },
              claimB: { signalExternalId: b.signal_external_id, text: b.text, url: b.url },
              reason: c.reason,
              detector: 'contradiction',
            },
          })
          already.add(key)
          proposed += 1
        }
      }
      return { proposed }
    },
  }
}

/** Cosine distance between the two clusters' seeds, above which a split is proposed. */
export const SPLIT_MIN_SEPARATION = 0.6
/** Below this many evidence signals, an entity is too thin to cluster. */
export const SPLIT_MIN_CLAIMS = 4

/** Cosine distance for already-normalised embedding vectors. */
function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  for (let i = 0; i < a.length && i < b.length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0)
  return 1 - dot
}

export interface SplitDetector {
  /** Proposes dividing an entity whose evidence forms two clear clusters (BRAIN-7 AC3). */
  detect(workspaceId: string): Promise<{ readonly proposed: number }>
}

export function createSplitDetector(deps: {
  readonly config: DbConfig
  readonly models: ModelProvider
  readonly embeddingModel: ModelRef
}): SplitDetector {
  const store = createEntityStore(deps.config)
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>) =>
    withTenant(workspaceId, fn, { config: deps.config })

  return {
    async detect(workspaceId) {
      const rows = await tx(workspaceId, (t) =>
        t.query<ClaimRow>(
          // Only brain-authored entities (BRAIN-11 AC3): splitting an external
          // entity would contradict the owning graph's identity for it.
          `SELECT e.id AS entity_id, e.name, s.external_id AS signal_external_id, s.text, s.url
             FROM entities e
             JOIN entity_evidence ev ON ev.entity_id = e.id
             JOIN signals s ON s.id = ev.signal_id AND s.text IS NOT NULL AND s.text <> ''
              -- Current versions only (BRAIN-1 AC3): two drafts of one page are not a
              -- contradiction, nor two clusters.
              AND NOT EXISTS (SELECT 1 FROM signals newer WHERE newer.supersedes_id = s.id)
            WHERE e.authority = 'brain'
            ORDER BY e.id, s.external_id`,
        ),
      )
      const byEntity = new Map<string, { name: string; claims: Map<string, ClaimRow> }>()
      for (const row of rows) {
        const entry = byEntity.get(row.entity_id) ?? { name: row.name, claims: new Map() }
        entry.claims.set(row.signal_external_id, row)
        byEntity.set(row.entity_id, entry)
      }

      const existing = new Set(
        (await store.allReviewItems(workspaceId))
          .filter((item) => item.kind === 'split')
          .map((item) => (item.subject as { entity?: { entityId?: string } }).entity?.entityId),
      )

      let proposed = 0
      for (const [entityId, entry] of byEntity) {
        if (existing.has(entityId)) continue
        const claims = [...entry.claims.values()]
        if (claims.length < SPLIT_MIN_CLAIMS) continue

        const vectors = await deps.models.embed(
          claims.map((c) => c.text),
          deps.embeddingModel,
        )

        // Two seeds: the first point, and the point farthest from it. If even
        // the farthest is close, the evidence is cohesive — no split.
        const seedA = vectors[0]!
        let seedBIndex = 0
        let maxDist = -1
        for (let i = 1; i < vectors.length; i += 1) {
          const d = cosineDistance(seedA, vectors[i]!)
          if (d > maxDist) {
            maxDist = d
            seedBIndex = i
          }
        }
        if (maxDist < SPLIT_MIN_SEPARATION) continue
        const seedB = vectors[seedBIndex]!

        // Assign each claim to its nearer seed.
        const clusterA: string[] = []
        const clusterB: string[] = []
        claims.forEach((c, i) => {
          const toA = cosineDistance(vectors[i]!, seedA)
          const toB = cosineDistance(vectors[i]!, seedB)
          ;(toA <= toB ? clusterA : clusterB).push(c.signal_external_id)
        })
        // A split needs two genuine groups, not one outlier.
        if (clusterA.length < 2 || clusterB.length < 2) continue

        await store.openReviewItem({
          workspaceId,
          kind: 'split',
          subject: {
            entity: { entityId, name: entry.name },
            clusterA,
            clusterB,
            separation: maxDist,
            detector: 'split',
          },
        })
        existing.add(entityId)
        proposed += 1
      }
      return { proposed }
    },
  }
}
