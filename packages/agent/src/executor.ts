import { createHash } from 'node:crypto'
import {
  NotFoundError,
  ulid,
  type WorkflowDefinition,
  type WorkflowStep,
} from '@chorus/core'
import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'
import type { ModelProvider, ModelRef } from '@chorus/llm'
import { withSpan } from '@chorus/telemetry'
import type { ToolRegistry } from './registry.js'

/**
 * The step executor (AGENT-1, architecture.md §11.1).
 *
 * The property this is built around is AC2:
 *
 * > the worker is killed and restarted → it resumes from the last completed
 * > step, **re-executes nothing**, and creates no duplicate artefact or
 * > external write.
 *
 * "Resumes from step four" is easy. "Re-executes nothing" is the hard half, and
 * it is what stops a resumed run opening a second pull request. So a completed
 * step is recognised by its **id and its input hash** together: the id says
 * which step, and the hash says whether it is the same work. Matching on
 * position instead would replay the wrong step the moment a definition gained
 * one.
 *
 * Durable state lives in Postgres rather than the queue (ADR-0004). BullMQ moves
 * work; it does not remember what a run has already done.
 */

export type RunStatus =
  | 'pending'
  | 'running'
  | 'waiting_human'
  | 'succeeded'
  | 'failed'
  | 'stopped'

export interface RunRecord {
  readonly id: string
  readonly workflowName: string
  readonly workflowVersion: number
  readonly status: RunStatus
}

export interface RunOutcome {
  readonly runId: string
  readonly status: RunStatus
  readonly stepsExecuted: number
  readonly stepsSkipped: number
  readonly error?: string
}

export interface ExecutorDeps {
  readonly registry: ToolRegistry
  readonly models: ModelProvider
  /**
   * Resolves a tier to a concrete model.
   *
   * Injected rather than read here, so no model name reaches this file and a
   * definition can name only a tier (AGENT-1 AC5, ADR-0015).
   */
  readonly modelFor: (tier: string) => ModelRef
  readonly now?: () => Date
}

export interface StartInput {
  readonly workspaceId: string
  readonly teamId: string
  readonly startedBy: string
  readonly definition: WorkflowDefinition
  readonly input: Readonly<Record<string, unknown>>
}

export interface Executor {
  start(input: StartInput): Promise<RunRecord>
  run(workspaceId: string, runId: string): Promise<RunOutcome>
}

/** Step ids this step references as `{{id.output}}`, anywhere in its definition. */
function dependenciesOf(step: WorkflowStep): string[] {
  const found = new Set<string>()
  for (const match of JSON.stringify(step).matchAll(/\{\{\s*([a-z][a-z0-9_]*)\.output\s*\}\}/g)) {
    found.add(match[1]!)
  }
  return [...found].sort()
}

/**
 * What a step's work depends on.
 *
 * Its own definition, plus **only the outputs it actually reads**. Hashing the
 * whole accumulated outputs map instead is the obvious implementation and it is
 * wrong: every earlier step's output is in that map by the time a later step
 * runs, so on resume the first step's hash no longer matches what was recorded
 * — and the executor re-runs everything, which is precisely the duplicate
 * external write AC2 exists to prevent.
 *
 * A step whose upstream output genuinely changed is different work and must run
 * again; one whose own inputs are identical has already been done.
 */
function hashInput(step: WorkflowStep, outputs: Readonly<Record<string, unknown>>): string {
  const relevant: Record<string, unknown> = {}
  for (const id of dependenciesOf(step)) relevant[id] = outputs[id]

  return createHash('sha256')
    .update(JSON.stringify({ step, inputs: relevant }))
    .digest('hex')
}

/**
 * Substitutes `{{step.output}}` references.
 *
 * Deliberately minimal — the walking skeleton's lesson is that a template
 * language grows teeth. A reference resolves to a previous step's output or it
 * fails; there is no expression evaluation, so a definition cannot compute.
 */
function resolve(value: unknown, outputs: Readonly<Record<string, unknown>>): unknown {
  if (typeof value !== 'string') return value
  const match = /^\{\{\s*([a-z][a-z0-9_]*)\.output\s*\}\}$/.exec(value)
  return match ? outputs[match[1]!] : value
}

export function createExecutor(config: DbConfig, deps: ExecutorDeps): Executor {
  const now = deps.now ?? (() => new Date())

  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>): Promise<T> =>
    withTenant(workspaceId, fn, { config })

  return {
    async start({ workspaceId, teamId, startedBy, definition, input }) {
      const id = ulid()

      await tx(workspaceId, async (t) => {
        // The definition is stored, not read from disk at run time, so a run can
        // be replayed against the version it actually used even after the file
        // changed. `DO NOTHING` because a version is immutable once published:
        // editing publishes a new version rather than mutating this row (AC4).
        await t.execute(
          `INSERT INTO workflows (id, workspace_id, name, version, definition, team_id, source)
           VALUES ($1, $2, $3, $4, $5, $6, 'built_in')
           ON CONFLICT (workspace_id, name, version) DO NOTHING`,
          [
            ulid(),
            workspaceId,
            definition.name,
            definition.version,
            JSON.stringify(definition),
            teamId || null,
          ],
        )

        await t.execute(
          `INSERT INTO runs
             (id, workspace_id, team_id, workflow_name, workflow_version, trigger,
              started_by, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
          [
            id,
            workspaceId,
            teamId,
            definition.name,
            // Pinned here (AC4). A workflow edited mid-run must not change what
            // this run is doing halfway through.
            definition.version,
            JSON.stringify({ input }),
            startedBy,
          ],
        )
      })

      return {
        id,
        workflowName: definition.name,
        workflowVersion: definition.version,
        status: 'pending',
      }
    },

    async run(workspaceId, runId) {
      const [run] = await tx(workspaceId, (t) =>
        t.query<{
          id: string
          status: RunStatus
          workflow_name: string
          workflow_version: number
          team_id: string | null
          started_by: string
          trigger: { input?: Record<string, unknown> }
        }>(
          `SELECT id, status, workflow_name, workflow_version, team_id, started_by, trigger
             FROM runs WHERE id = $1`,
          [runId],
        ),
      )
      // Another workspace's run and one that never existed are alike from here:
      // row-level security did not surface it.
      if (!run) throw new NotFoundError('No such run', { runId })

      // A queue delivering the same run twice is normal, not exceptional, under
      // at-least-once delivery. A finished run is a no-op rather than an error.
      if (run.status === 'succeeded' || run.status === 'stopped') {
        return { runId, status: run.status, stepsExecuted: 0, stepsSkipped: 0 }
      }

      const definition = await loadDefinition(workspaceId, run.workflow_name, run.workflow_version)

      // What already happened. Keyed by step id, because matching by position
      // replays the wrong step the moment a definition gains one.
      const done = new Map(
        (
          await tx(workspaceId, (t) =>
            t.query<{ step_id: string; status: string; input_hash: string; output: unknown }>(
              `SELECT step_id, status, input_hash, output FROM run_steps WHERE run_id = $1`,
              [runId],
            ),
          )
        ).map((row) => [row.step_id, row]),
      )

      const outputs: Record<string, unknown> = {}
      for (const [stepId, row] of done) {
        if (row.status === 'succeeded') outputs[stepId] = row.output
      }

      await tx(workspaceId, (t) =>
        t.execute(`UPDATE runs SET status = 'running' WHERE id = $1`, [runId]),
      )

      let executed = 0
      let skipped = 0
      let seq = done.size

      const actorRole = await roleOf(workspaceId, run.started_by)

      for (const step of definition.steps) {
        const inputHash = hashInput(step, outputs)
        const previous = done.get(step.id)

        // The whole of AC2's "re-executes nothing": same step, same inputs,
        // already succeeded.
        if (previous?.status === 'succeeded' && previous.input_hash === inputHash) {
          skipped += 1
          continue
        }

        seq += 1
        const stepRowId = ulid()
        await tx(workspaceId, (t) =>
          t.execute(
            `INSERT INTO run_steps
               (id, workspace_id, run_id, seq, step_id, step_type, input_hash, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'running')
             ON CONFLICT (run_id, step_id) DO UPDATE
               SET seq = EXCLUDED.seq, input_hash = EXCLUDED.input_hash,
                   status = 'running', error = NULL, started_at = now()`,
            [stepRowId, workspaceId, runId, seq, step.id, step.type, inputHash],
          ),
        )

        try {
          const output = await withSpan(
            `agent.step.${step.type}`,
            {
              'chorus.workspace_id': workspaceId,
              'chorus.run_id': runId,
              'chorus.step_id': step.id,
              'chorus.workflow': `${definition.name}@${definition.version}`,
            },
            () =>
              executeStep({
                step,
                definition,
                outputs,
                workspaceId,
                teamId: run.team_id ?? '',
                runId,
                actor: { userId: run.started_by, role: actorRole },
              }),
          )

          outputs[step.id] = output
          executed += 1

          await tx(workspaceId, (t) =>
            t.execute(
              `UPDATE run_steps SET status = 'succeeded', output = $1, finished_at = now()
                WHERE run_id = $2 AND step_id = $3`,
              [JSON.stringify(output ?? null), runId, step.id],
            ),
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)

          await tx(workspaceId, async (t) => {
            await t.execute(
              `UPDATE run_steps SET status = 'failed', error = $1, finished_at = now()
                WHERE run_id = $2 AND step_id = $3`,
              [message, runId, step.id],
            )
            await t.execute(
              `UPDATE runs SET status = 'failed', error = $1, finished_at = now() WHERE id = $2`,
              [message, runId],
            )
            await t.execute(
              `INSERT INTO run_events (id, workspace_id, run_id, seq, kind, payload)
               VALUES ($1, $2, $3, $4, 'error', $5)`,
              [ulid(), workspaceId, runId, seq, JSON.stringify({ step: step.id, message })],
            )
          })

          // Both recorded: the run says it failed, the step says which one and
          // why, so a failure is diagnosable without reading the logs.
          return { runId, status: 'failed', stepsExecuted: executed, stepsSkipped: skipped, error: message }
        }
      }

      await tx(workspaceId, (t) =>
        t.execute(
          `UPDATE runs SET status = 'succeeded', finished_at = now() WHERE id = $1`,
          [runId],
        ),
      )
      return { runId, status: 'succeeded', stepsExecuted: executed, stepsSkipped: skipped }
    },
  }

  /** The definition a run is pinned to, from the row it was stored in. */
  async function loadDefinition(
    workspaceId: string,
    name: string,
    version: number,
  ): Promise<WorkflowDefinition> {
    const [row] = await tx(workspaceId, (t) =>
      t.query<{ definition: WorkflowDefinition }>(
        `SELECT definition FROM workflows
          WHERE name = $1 AND version = $2 AND deleted_at IS NULL`,
        [name, version],
      ),
    )
    if (!row) {
      throw new NotFoundError(`No workflow "${name}" at version ${version}`, { name, version })
    }
    return row.definition
  }

  async function roleOf(workspaceId: string, userId: string): Promise<'member' | 'senior_member' | 'admin' | 'owner'> {
    const [row] = await tx(workspaceId, (t) =>
      t.query<{ role: 'member' | 'senior_member' | 'admin' | 'owner' }>(
        `SELECT role FROM workspace_members
          WHERE workspace_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [workspaceId, userId],
      ),
    )
    // A run whose starter has left the workspace acts with the least authority
    // rather than the most.
    return row?.role ?? 'member'
  }

  async function executeStep(input: {
    step: WorkflowStep
    definition: WorkflowDefinition
    outputs: Record<string, unknown>
    workspaceId: string
    teamId: string
    runId: string
    actor: { userId: string; role: 'member' | 'senior_member' | 'admin' | 'owner' }
  }): Promise<unknown> {
    const { step, definition, outputs, workspaceId, teamId, runId, actor } = input
    const ctx = { workspaceId, teamId, runId, actor, now }

    switch (step.type) {
      case 'tool': {
        const result = await deps.registry.invoke(
          step.tool,
          resolve(step.input, outputs) ?? {},
          ctx,
          { allowed: definition.tools },
        )
        await recordEvent(workspaceId, runId, 'tool_call', {
          step: step.id,
          tool: step.tool,
        })
        return result
      }

      case 'model': {
        // The definition named a tier; configuration decides the model.
        const model = deps.modelFor(definition.model)
        let text = ''
        for await (const event of deps.models.stream({
          model,
          messages: [{ role: 'user', content: renderPrompt(step.prompt, outputs) }],
          context: { workspaceId, teamId, runId, purpose: 'chat' },
        })) {
          if (event.type === 'token') text += event.text
          if (event.type === 'error') throw new Error(event.message)
        }

        await recordEvent(workspaceId, runId, 'model_call', {
          step: step.id,
          model: model.model,
          prompt: step.prompt,
        })
        return text
      }

      // The remaining step types arrive with the slices that need them:
      // `checkpoint` with AGENT-3, `retrieve` with BRAIN-4, `emit` with the
      // artefact models. Refusing loudly beats a silent no-op that makes a
      // workflow look like it ran.
      default:
        throw new NotFoundError(`Step type "${step.type}" is not implemented yet`, {
          step: step.id,
          type: step.type,
        })
    }
  }

  /**
   * Placeholder rendering.
   *
   * The prompt registry (`workflows/prompts/**`) is wired in with the built-in
   * workflows; until then a step's prompt path plus its inputs is what reaches
   * the model, which is enough to prove the tier resolution and the streaming.
   */
  function renderPrompt(path: string, outputs: Readonly<Record<string, unknown>>): string {
    return `${path}\n\n${JSON.stringify(outputs)}`
  }

  async function recordEvent(
    workspaceId: string,
    runId: string,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx(workspaceId, async (t) => {
      const [last] = await t.query<{ next: number }>(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = $1`,
        [runId],
      )
      await t.execute(
        `INSERT INTO run_events (id, workspace_id, run_id, seq, kind, payload)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [ulid(), workspaceId, runId, last?.next ?? 1, kind, JSON.stringify(payload)],
      )
    })
  }
}
