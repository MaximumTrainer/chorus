import { z } from 'zod'
import {
  EDGE_KINDS,
  ENTITY_KINDS,
  ulid,
  type EdgeCandidate,
  type EntityCandidate,
} from '@chorus/core'
import { withTenant, type DbConfig } from '@chorus/db'
import { renderPrompt, type ModelProvider, type ModelRef, type Prompt } from '@chorus/llm'
import { createEntityStore } from './entities.js'
import { createExtractionIngestor, type IngestOutcome } from './extraction.js'

/**
 * The LLM extraction pass (BRAIN-3, architecture.md §10.3).
 *
 * The second of the two passes: a cheap model reads a signal's text and
 * proposes the entities and edges the deterministic pass could not — with a
 * strict output schema, so a field the model invents is rejected rather than
 * repaired, and with a character span for each, so every candidate's evidence
 * leads back to the exact text that justifies it (AC2). What it proposes is
 * resolved against the existing graph by the ingestor — merged when confident,
 * proposed for review when not. Its spend is recorded per call (AC6).
 */

/** The strict shape the model must return — anything else is rejected, not repaired. */
export const ExtractionOutputSchema = z.object({
  entities: z
    .array(
      z.object({
        kind: z.enum(ENTITY_KINDS),
        name: z.string().min(1),
        aliases: z.array(z.string()).default([]),
        charStart: z.number().int().min(0),
        charEnd: z.number().int().min(0),
      }),
    )
    .default([]),
  edges: z
    .array(
      z.object({
        kind: z.enum(EDGE_KINDS),
        from: z.string().min(1),
        to: z.string().min(1),
        confidence: z.number().min(0).max(1),
      }),
    )
    .default([]),
})

export interface LlmExtractInput {
  readonly workspaceId: string
  readonly teamId?: string
  readonly signalId: string
  readonly signalExternalId: string
  readonly source: string
  readonly text: string
  readonly extractorVersion: number
}

export interface LlmExtractor {
  extract(input: LlmExtractInput): Promise<IngestOutcome>
}

/** A stable external id for an LLM-proposed entity, so re-extraction is idempotent. */
function externalIdFor(kind: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `llm:${kind}:${slug || 'unnamed'}`
}

export interface LlmExtractorDeps {
  readonly config: DbConfig
  readonly models: ModelProvider
  readonly modelFor: (tier: string) => ModelRef
  readonly prompt: Prompt
  /** Cost of a call in integer cents, for the spend ledger (AC6). Zero when unpriced. */
  readonly priceFor?: (model: ModelRef, usage: { inputTokens: number; outputTokens: number }) => number
}

export function createLlmExtractor(deps: LlmExtractorDeps): LlmExtractor {
  const ingestor = createExtractionIngestor(createEntityStore(deps.config))
  // The cheap tier: nightly extraction over a large graph must not cost what a
  // chat turn does (AC6).
  const model = deps.modelFor('fast')

  return {
    async extract({ workspaceId, teamId, signalId, signalExternalId, source, text, extractorVersion }) {
      const { value, usage } = await deps.models.generate({
        model,
        messages: [{ role: 'user', content: renderPrompt(deps.prompt, { text }) }],
        context: { workspaceId, teamId: teamId ?? '', purpose: 'extract' },
        schema: ExtractionOutputSchema,
        schemaName: 'entity_extraction',
      })

      const entities: EntityCandidate[] = value.entities.map((e) => ({
        kind: e.kind,
        externalId: externalIdFor(e.kind, e.name),
        name: e.name,
        aliases: e.aliases,
        attributes: {},
        evidence: { signalExternalId, source, charStart: e.charStart, charEnd: e.charEnd },
      }))

      // Edges name entities by name; resolve each to the id this batch minted.
      const idByName = new Map(value.entities.map((e) => [e.name, externalIdFor(e.kind, e.name)]))
      const edges: EdgeCandidate[] = value.edges.flatMap((ed) => {
        const from = idByName.get(ed.from)
        const to = idByName.get(ed.to)
        if (!from || !to) return []
        return [
          {
            kind: ed.kind,
            fromExternalId: from,
            toExternalId: to,
            confidence: ed.confidence,
            evidence: { signalExternalId, source },
          },
        ]
      })

      const outcome = await ingestor.ingest(workspaceId, { signalId, extractorVersion, entities, edges })

      // Spend is recorded as the call happens (AC6): a scheduled extraction
      // belongs to no run, so run_id is null and the purpose names the pass.
      const costCents = deps.priceFor
        ? deps.priceFor(model, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })
        : 0
      await withTenant(
        workspaceId,
        (t) =>
          t.execute(
            `INSERT INTO spend_ledger
               (id, workspace_id, team_id, provider, model, purpose, tokens_in, tokens_cached_in, tokens_out, cost_cents)
             VALUES ($1, $2, $3, $4, $5, 'extract', $6, $7, $8, $9)`,
            [
              ulid(),
              workspaceId,
              teamId ?? null,
              model.provider,
              model.model,
              usage.inputTokens,
              usage.cachedInputTokens ?? 0,
              usage.outputTokens,
              costCents,
            ],
          ),
        { config: deps.config },
      )

      return outcome
    },
  }
}
