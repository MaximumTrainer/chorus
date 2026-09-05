import { z } from 'zod'
import { ulid, WorkflowDefinitionSchema } from '@chorus/core'
import { withTenant, type DbConfig } from '@chorus/db'
import { createExecutor, createToolRegistry, builtInWorkflows } from '@chorus/agent'
import { loadPromptDirectory } from '@chorus/llm'
import type { ModelProvider, ModelRef } from '@chorus/llm'
import { join } from 'node:path'
import { WORKFLOW_ROOT } from '@chorus/agent'
import type { EditSuggester } from './suggestions.js'

/**
 * Producing a set of suggestions (DOC-3, AGENT-1).
 *
 * The model call goes through a workflow, like every other model call in the
 * system — which is what makes it traceable, replayable and governed by the
 * same policies. DOC-3's scope says as much: the model call is AGENT-1's, and
 * this is only the part that turns its answer into suggestions.
 */

/**
 * What a suggestion has to be to be worth offering.
 *
 * `original` is the anchor. A suggestion whose quotation is empty would match
 * everywhere; one whose replacement is identical to the original is a decision
 * with no outcome, and asking somebody to make it wastes the attention this
 * feature exists to protect.
 */
const ProposalSchema = z.object({
  suggestions: z
    .array(
      z.object({
        original: z.string().min(1),
        replacement: z.string(),
        reason: z.string().optional(),
      }),
    )
    .max(50),
})

export function createEditSuggester(
  config: DbConfig,
  deps: { models: ModelProvider; modelFor: (tier: string) => ModelRef },
): EditSuggester {
  const prompts = loadPromptDirectory(join(WORKFLOW_ROOT, '..', 'prompts'))
  const workflows = builtInWorkflows()

  const executor = createExecutor(config, {
    registry: createToolRegistry([]),
    models: deps.models,
    modelFor: deps.modelFor,
    prompts: { get: (id) => prompts.get(id) },
  })

  return async ({ workspaceId, documentId, setId, teamId, userId, instruction, passage }) => {
    const fail = (message: string) =>
      withTenant(
        workspaceId,
        (t) =>
          t.execute(
            `UPDATE document_suggestion_sets SET status = 'failed', error = $2 WHERE id = $1`,
            [setId, message],
          ),
        { config },
      )

    let output: unknown
    let runId: string | undefined

    try {
      const definition = WorkflowDefinitionSchema.parse(workflows.latest('suggest-edits'))
      const run = await executor.start({
        workspaceId,
        teamId,
        startedBy: userId,
        definition,
        input: { instruction, passage },
      })
      runId = run.id

      const outcome = await executor.run(workspaceId, run.id)
      if (outcome.status !== 'succeeded') {
        // The run's own words. "The provider is down" and "the prompt was
        // rejected" send somebody to different places, and collapsing them into
        // "generation failed" sends them to neither.
        await fail(outcome.error ?? 'The suggestion run did not finish.')
        return
      }

      const [step] = await withTenant(
        workspaceId,
        (t) =>
          t.query<{ output: unknown }>(
            `SELECT output FROM run_steps WHERE run_id = $1 AND step_id = 'propose'`,
            [run.id],
          ),
        { config },
      )
      output = step?.output
    } catch (cause) {
      await fail(cause instanceof Error ? cause.message : String(cause))
      return
    }

    const parsed = parseProposal(output)
    if (!parsed) {
      // Unusable output is a failure, not an empty result (AC6). "It suggested
      // nothing" is a legitimate answer to a well-written passage, and a reader
      // told that when the model actually returned prose will not retry.
      await fail('The model did not answer with suggestions this could use.')
      return
    }

    await withTenant(
      workspaceId,
      async (t) => {
        const [document] = await t.query<{ body_md_cache: string | null }>(
          `SELECT body_md_cache FROM documents WHERE id = $1`,
          [documentId],
        )
        const whole = document?.body_md_cache ?? ''

        let sequence = 0
        for (const suggestion of parsed.suggestions) {
          // Two filters, both at generation rather than at acceptance.
          //
          // In the passage: a model asked about one paragraph that answers
          // about two would otherwise edit text the person never offered up
          // (AC3). In the document exactly once: models invent quotations, and
          // one kept would be offered to somebody and then refuse to apply.
          if (!passage.includes(suggestion.original)) continue
          if (occurrences(whole, suggestion.original) !== 1) continue
          if (suggestion.replacement === suggestion.original) continue

          sequence += 1
          await t.execute(
            `INSERT INTO document_suggestions
               (id, workspace_id, set_id, sequence, original_text, replacement_text, reason)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              ulid(),
              workspaceId,
              setId,
              sequence,
              suggestion.original,
              suggestion.replacement,
              suggestion.reason ?? null,
            ],
          )
        }

        await t.execute(
          `UPDATE document_suggestion_sets SET status = 'ready', run_id = $2 WHERE id = $1`,
          [setId, runId ?? null],
        )
      },
      { config },
    )
  }
}

function occurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

/**
 * The model's answer, if it is one.
 *
 * A model asked for JSON usually returns JSON, sometimes wrapped in prose, and
 * occasionally returns an essay. Taking the outermost braces handles the middle
 * case without inventing a parser; the last one has to fail, loudly.
 */
function parseProposal(output: unknown): z.infer<typeof ProposalSchema> | undefined {
  if (typeof output !== 'string') return undefined
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined

  try {
    const result = ProposalSchema.safeParse(JSON.parse(output.slice(start, end + 1)))
    return result.success ? result.data : undefined
  } catch {
    return undefined
  }
}
