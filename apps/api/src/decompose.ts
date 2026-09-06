import { join } from 'node:path'
import {
  resolveCheckpointPolicy,
  ulid,
  ValidationError,
  type PolicyRule,
  type ResolvedPolicy,
} from '@chorus/core'
import { withTenant, type DbConfig } from '@chorus/db'
import {
  builtInWorkflows,
  createExecutor,
  createToolRegistry,
  WORKFLOW_ROOT,
} from '@chorus/agent'
import { WorkflowDefinitionSchema } from '@chorus/core'
import { loadPromptDirectory } from '@chorus/llm'
import type { ModelProvider, ModelRef } from '@chorus/llm'
import type { Retriever } from '@chorus/core'
import { createDocumentService } from './documents.js'
import { createProposalService } from './proposals.js'
import type { ProposalRecord } from './proposals.js'

/**
 * Decomposing a document into a proposed task tree (DOC-6, CHAT-5 AC6).
 *
 * > This is the hinge between Shape and Deliver.
 *
 * The run produces a tree; this turns it into a proposal, and the team's
 * `before_create_artefacts` policy decides whether a person sees it first.
 * Both halves live here because they are one decision: a decomposition that
 * wrote tasks directly would step around the gate while looking like it
 * worked, and a gate that ignored the policy would ask a team that has
 * explicitly said it does not want to be asked.
 */

export interface Decomposer {
  decompose(input: {
    workspaceId: string
    documentId: string
    actorId: string
  }): Promise<ProposalRecord & { runId: string }>
}

export function createDecomposer(
  config: DbConfig,
  deps: {
    models: ModelProvider
    modelFor: (tier: string) => ModelRef
    retriever?: Retriever
  },
): Decomposer {
  const prompts = loadPromptDirectory(join(WORKFLOW_ROOT, '..', 'prompts'))
  const workflows = builtInWorkflows()

  const documents = createDocumentService(config)
  const proposals = createProposalService(config)

  const executor = createExecutor(config, {
    registry: createToolRegistry([]),
    models: deps.models,
    modelFor: deps.modelFor,
    prompts: { get: (id) => prompts.get(id) },
    ...(deps.retriever ? { retriever: deps.retriever } : {}),
  })

  return {
    async decompose({ workspaceId, documentId, actorId }) {
      const document = await documents.get(workspaceId, documentId)

      const definition = WorkflowDefinitionSchema.parse(workflows.latest('decompose-tasks'))
      const run = await executor.start({
        workspaceId,
        teamId: document.teamId,
        startedBy: actorId,
        definition,
        input: {
          document: asText(document),
          documentType: document.type,
        },
      })

      const outcome = await executor.run(workspaceId, run.id)
      if (outcome.status !== 'succeeded') {
        // The run's own words. "The provider is down" and "the model answered
        // with prose" send somebody to different places.
        throw new ValidationError(outcome.error ?? 'The decomposition did not finish.', {
          runId: run.id,
        })
      }

      const tree = parseNodes(outcome.output)
      if (!tree) {
        throw new ValidationError(
          'The model did not answer with a task tree this could use.',
          { runId: run.id },
        )
      }

      const proposed = await proposals.propose({
        workspaceId,
        teamId: document.teamId,
        runId: run.id,
        sourceDocumentId: documentId,
        tree,
      })

      // The team's standing answer to "should somebody look at this first?".
      const policy = await policyFor(config, workspaceId, document.teamId, definition.name)
      await recordDecision(config, workspaceId, run.id, policy)

      if (policy.mode !== 'auto') return { ...proposed, runId: run.id }

      // `auto` means the tree lands as tasks without anybody being asked. The
      // decision is already in the trace above, because "nobody was asked" is
      // a fact about how these tasks came to exist and the trace is where
      // somebody goes to find out.
      const confirmed = await proposals.confirm({
        workspaceId,
        proposalId: proposed.id,
        actorId,
      })
      return { ...confirmed, runId: run.id }
    },
  }
}

/** The document as the prompt reads it: a title and its sections in order. */
function asText(document: {
  title: string
  sections: ReadonlyArray<{ key: string; content?: string | null }>
}): string {
  const body = document.sections
    .map((section) => `## ${section.key}\n\n${section.content ?? ''}`)
    .join('\n\n')
  return `# ${document.title}\n\n${body}`
}

/** The tree a model produced, or nothing if it answered with something else. */
function parseNodes(output: unknown): unknown {
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? '')
  try {
    const parsed = JSON.parse(text) as { nodes?: unknown }
    return Array.isArray(parsed.nodes) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function policyFor(
  config: DbConfig,
  workspaceId: string,
  teamId: string,
  workflowName: string,
): Promise<ResolvedPolicy> {
  const rows = await withTenant(
    workspaceId,
    (t) =>
      t.query<{
        team_id: string | null
        workflow_name: string | null
        checkpoint_kind: 'before_create_artefacts'
        mode: 'auto' | 'ask' | 'never'
      }>(
        `SELECT team_id, workflow_name, checkpoint_kind, mode
           FROM policies
          WHERE checkpoint_kind = 'before_create_artefacts' AND deleted_at IS NULL`,
      ),
    { config },
  )

  // `null` becomes `undefined` deliberately. The resolver's team tier matches
  // on `workflowName === undefined`, and a rule carrying SQL's `null` misses
  // it — falling through to the platform default, which is `ask`. A team that
  // set `auto` would then be asked anyway, and the setting would look ignored
  // rather than broken.
  const rules: PolicyRule[] = rows.map((row) => ({
    teamId: row.team_id ?? undefined,
    workflowName: row.workflow_name ?? undefined,
    checkpointKind: row.checkpoint_kind,
    mode: row.mode,
  }))

  return resolveCheckpointPolicy(rules, {
    checkpointKind: 'before_create_artefacts',
    teamId,
    workflowName,
  })
}

/**
 * The gate's decision, written to the run's own trace.
 *
 * Recorded whichever way it went. A trace that only mentions the gate when it
 * stopped something cannot answer "was anybody asked?", which is the question
 * somebody has when they find tasks they did not expect.
 */
async function recordDecision(
  config: DbConfig,
  workspaceId: string,
  runId: string,
  policy: ResolvedPolicy,
): Promise<void> {
  await withTenant(
    workspaceId,
    async (t) => {
      const [last] = await t.query<{ next: number }>(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = $1`,
        [runId],
      )
      await t.execute(
        `INSERT INTO run_events (id, workspace_id, run_id, seq, kind, payload)
         VALUES ($1, $2, $3, $4, 'checkpoint', $5::jsonb)`,
        [
          ulid(),
          workspaceId,
          runId,
          last!.next,
          JSON.stringify({
            checkpointKind: 'before_create_artefacts',
            mode: policy.mode,
            source: policy.source,
            decidedBy: policy.mode === 'auto' ? 'policy' : 'awaiting_person',
          }),
        ],
      )
    },
    { config },
  )
}
