import { createHash } from 'node:crypto'
import {
  NotFoundError,
  resolveCheckpointPolicy,
  ulid,
  type CheckpointKind,
  type PolicyRule,
  type ResolvedPolicy,
  type WorkflowDefinition,
  type WorkflowStep,
} from '@chorus/core'
import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'
import {
  CHECKPOINT_COLUMNS,
  toCheckpointRecord,
  type CheckpointRecord,
  type CheckpointRow,
} from './checkpoints.js'
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
  /**
   * How long an `ask` checkpoint waits before it expires (AGENT-3 AC6).
   *
   * Three days by default: long enough to survive a weekend, short enough that
   * a forgotten gate does not sit open indefinitely. A paused run holds no
   * resources, so the cost of the window is staleness, not capacity.
   */
  readonly checkpointTtlMs?: number
}

const DEFAULT_CHECKPOINT_TTL_MS = 72 * 60 * 60 * 1000

/**
 * What a step did, rather than what it returned.
 *
 * A checkpoint does not produce a value — it decides whether the run continues
 * at all — so the executor needs three answers, not one. Signalling a pause by
 * throwing would record the step as failed, and a run waiting for a person is
 * not a failure.
 */
type StepResult =
  | { readonly kind: 'output'; readonly output: unknown }
  | { readonly kind: 'pause' }
  | { readonly kind: 'stop'; readonly reason: string }

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

/**
 * Expiring unanswered checkpoints (AGENT-3 AC6).
 *
 * A gate nobody answers must end its run rather than hold it open forever. The
 * deadline is a column, not a timer in a process's memory, so expiry survives
 * every restart and is a query any worker can run.
 *
 * The direction matters: expiry **ends** the run and does not perform the
 * gated action. The safe default when a human never answered is that nothing
 * happened, so a forgotten approval can never become an implicit one.
 *
 * Returns how many it swept, which is what makes "nothing expired" a fact a
 * test can assert rather than an absence it has to infer.
 */
export async function expireCheckpoints(
  config: DbConfig,
  options: { workspaceId: string; now?: () => Date },
): Promise<number> {
  const at = (options.now ?? (() => new Date()))()

  return withTenant(
    options.workspaceId,
    async (t) => {
      const expired = await t.query<{ id: string; run_id: string; kind: string }>(
        `UPDATE checkpoints
            SET status = 'expired', decided_at = $1
          WHERE status = 'pending' AND expires_at <= $1
          RETURNING id, run_id, kind`,
        [at.toISOString()],
      )

      for (const row of expired) {
        // Stopped, not failed: the run did exactly what it was told to do when
        // nobody answered.
        await t.execute(
          `UPDATE runs
              SET status = 'stopped', error = $2, finished_at = $3
            WHERE id = $1 AND status = 'waiting_human'`,
          [
            row.run_id,
            `Stopped at ${row.kind}: the checkpoint expired unanswered, ` +
              `so the action was not performed.`,
            at.toISOString(),
          ],
        )
        await t.execute(
          `UPDATE run_steps SET status = 'skipped', finished_at = $2
            WHERE run_id = $1 AND status = 'waiting'`,
          [row.run_id, at.toISOString()],
        )
        const [last] = await t.query<{ next: number }>(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = $1`,
          [row.run_id],
        )
        await t.execute(
          `INSERT INTO run_events (id, workspace_id, run_id, seq, kind, payload)
           VALUES ($1, $2, $3, $4, 'checkpoint', $5)`,
          [
            ulid(),
            options.workspaceId,
            row.run_id,
            last?.next ?? 1,
            JSON.stringify({ checkpoint: row.id, outcome: 'expired' }),
          ],
        )
      }

      return expired.length
    },
    { config },
  )
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
          const result = await withSpan(
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

          if (result.kind === 'pause') {
            // Waiting, not running. A paused run left as `running` is
            // indistinguishable from a stuck one, and stuck is what an operator
            // is meant to act on.
            await tx(workspaceId, async (t) => {
              await t.execute(
                `UPDATE run_steps SET status = 'waiting' WHERE run_id = $1 AND step_id = $2`,
                [runId, step.id],
              )
              await t.execute(`UPDATE runs SET status = 'waiting_human' WHERE id = $1`, [runId])
            })
            return {
              runId,
              status: 'waiting_human',
              stepsExecuted: executed,
              stepsSkipped: skipped,
            }
          }

          if (result.kind === 'stop') {
            // Stopped, not failed. A policy of `never`, a rejection or an
            // expiry are all the system working as asked; recording them as
            // failures would put healthy runs in an error dashboard.
            await tx(workspaceId, async (t) => {
              await t.execute(
                `UPDATE run_steps SET status = 'skipped', finished_at = now()
                  WHERE run_id = $1 AND step_id = $2`,
                [runId, step.id],
              )
              await t.execute(
                `UPDATE runs SET status = 'stopped', error = $1, finished_at = now()
                  WHERE id = $2`,
                [result.reason, runId],
              )
            })
            return {
              runId,
              status: 'stopped',
              stepsExecuted: executed,
              stepsSkipped: skipped,
              error: result.reason,
            }
          }

          const output = result.output
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
  }): Promise<StepResult> {
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
        return { kind: 'output', output: result }
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
        return { kind: 'output', output: text }
      }

      case 'checkpoint':
        return gate({ step: step.id, kind: step.kind, definition, outputs, workspaceId, teamId, runId })

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
   * The gate (AGENT-3).
   *
   * Reached twice in the life of a paused run: once on the way in, when it
   * creates the checkpoint and stops, and once on the way back, when a decision
   * has been made and it either continues or ends the run. So the first thing
   * it does is look for a checkpoint that already exists — a run reaching this
   * step is more often resuming than arriving.
   */
  async function gate(input: {
    step: string
    kind: CheckpointKind
    definition: WorkflowDefinition
    outputs: Readonly<Record<string, unknown>>
    workspaceId: string
    teamId: string
    runId: string
  }): Promise<StepResult> {
    const { step, kind, definition, outputs, workspaceId, teamId, runId } = input

    const existing = await readGate(workspaceId, runId, step)
    if (existing) return continueFrom(existing)

    const policy = await resolvePolicy(workspaceId, teamId, definition.name, kind)

    if (policy.mode === 'never') {
      // AC5: prevented, not paused. No row is created, which is what makes
      // "asks nobody" structural rather than a promise — there is nothing for
      // any surface to present, and no answer that could change the outcome.
      await recordEvent(workspaceId, runId, 'checkpoint', {
        step,
        kind,
        mode: 'never',
        source: policy.source,
      })
      return {
        kind: 'stop',
        reason:
          `Stopped at ${kind}: the ${policy.source} policy is "never", ` +
          `so this run may not proceed past it.`,
      }
    }

    const payload = await proposalFor({
      kind,
      step,
      definition,
      outputs,
      workspaceId,
      runId,
      policy,
    })
    const auto = policy.mode === 'auto'
    const expiresAt = new Date(
      now().getTime() + (deps.checkpointTtlMs ?? DEFAULT_CHECKPOINT_TTL_MS),
    )

    await tx(workspaceId, (t) =>
      t.execute(
        `INSERT INTO checkpoints
           (id, workspace_id, run_id, step_id, kind, policy_source, mode, status, payload,
            decision, decided_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (run_id, step_id) DO NOTHING`,
        [
          ulid(),
          workspaceId,
          runId,
          step,
          kind,
          policy.source,
          policy.mode,
          // A gate passed automatically is still a gate that was passed. Not
          // recording it would leave a trace unable to answer "who allowed
          // this" — and "the team's policy did" is a legitimate answer, but
          // only if there is a row to say so.
          auto ? 'approved' : 'pending',
          JSON.stringify(payload),
          auto ? 'approve' : null,
          auto ? now().toISOString() : null,
          expiresAt.toISOString(),
        ],
      ),
    )

    await recordEvent(workspaceId, runId, 'checkpoint', {
      step,
      kind,
      mode: policy.mode,
      source: policy.source,
    })

    // Re-read rather than trust the insert: `DO NOTHING` means another worker
    // may have created the row, and if that one was answered in the meantime
    // this run should honour the answer rather than wait for a second one.
    const created = await readGate(workspaceId, runId, step)
    return created ? continueFrom(created) : { kind: 'pause' }
  }

  /** What a settled — or still unsettled — checkpoint means for the run. */
  function continueFrom(checkpoint: CheckpointRecord): StepResult {
    switch (checkpoint.status) {
      case 'pending':
        return { kind: 'pause' }

      case 'approved':
        return {
          kind: 'output',
          output: {
            approved: true,
            decision: checkpoint.decision,
            decidedBy: checkpoint.decidedBy,
            // What the human allowed, which is not always what was proposed.
            payload: checkpoint.editedPayload ?? checkpoint.payload,
          },
        }

      case 'rejected':
        return {
          kind: 'stop',
          reason: checkpoint.decisionNote
            ? `Rejected at ${checkpoint.kind}: ${checkpoint.decisionNote}`
            : `Rejected at ${checkpoint.kind}.`,
        }

      case 'expired':
        return {
          kind: 'stop',
          reason:
            `Stopped at ${checkpoint.kind}: the checkpoint expired unanswered, ` +
            `so the action was not performed.`,
        }
    }
  }

  async function readGate(
    workspaceId: string,
    runId: string,
    stepId: string,
  ): Promise<CheckpointRecord | undefined> {
    const [row] = await tx(workspaceId, (t) =>
      t.query<CheckpointRow>(
        `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE run_id = $1 AND step_id = $2`,
        [runId, stepId],
      ),
    )
    return row ? toCheckpointRecord(row) : undefined
  }

  /**
   * The policy tiers, read from rows and resolved by the shared pure function.
   *
   * Resolution lives in `packages/core` and the API consumes the same function.
   * Two implementations would eventually disagree, and a disagreement here is a
   * gate that silently stopped gating.
   */
  async function resolvePolicy(
    workspaceId: string,
    teamId: string,
    workflowName: string,
    kind: CheckpointKind,
  ): Promise<ResolvedPolicy> {
    const rows = await tx(workspaceId, (t) =>
      t.query<{
        team_id: string | null
        workflow_name: string | null
        checkpoint_kind: CheckpointKind
        mode: 'auto' | 'ask' | 'never'
        spend_threshold_cents: number | null
      }>(
        `SELECT team_id, workflow_name, checkpoint_kind, mode, spend_threshold_cents
           FROM policies
          WHERE checkpoint_kind = $1 AND deleted_at IS NULL`,
        [kind],
      ),
    )

    const rules: PolicyRule[] = rows.map((row) => ({
      teamId: row.team_id ?? undefined,
      workflowName: row.workflow_name ?? undefined,
      checkpointKind: row.checkpoint_kind,
      mode: row.mode,
      spendThresholdCents: row.spend_threshold_cents ?? undefined,
    }))

    return resolveCheckpointPolicy(rules, { teamId, workflowName, checkpointKind: kind })
  }

  /**
   * What the person deciding is shown.
   *
   * "Present the actual payload — the tasks that would be created, the message
   * that would be posted — not a summary." So this carries the run's
   * accumulated outputs, which is literally the work the next step would act
   * on.
   */
  async function proposalFor(input: {
    kind: CheckpointKind
    step: string
    definition: WorkflowDefinition
    outputs: Readonly<Record<string, unknown>>
    workspaceId: string
    runId: string
    policy: ResolvedPolicy
  }): Promise<Record<string, unknown>> {
    const { kind, step, definition, outputs, workspaceId, runId, policy } = input
    const base: Record<string, unknown> = {
      step,
      workflow: `${definition.name}@${definition.version}`,
      kind,
      proposed: outputs,
    }

    if (kind !== 'before_spend_over') return base

    // AC7: spend so far, the threshold, and what finishing is likely to cost.
    // "You have spent 412" answers nothing on its own.
    const [row] = await tx(workspaceId, (t) =>
      t.query<{ cost_cents: number; done: string }>(
        `SELECT r.cost_cents,
                (SELECT count(*) FROM run_steps s
                  WHERE s.run_id = r.id AND s.status = 'succeeded') AS done
           FROM runs r WHERE r.id = $1`,
        [runId],
      ),
    )
    const spent = row?.cost_cents ?? 0
    const done = Number(row?.done ?? 0)
    const remaining = Math.max(0, definition.steps.length - done - 1)

    return {
      ...base,
      spendSoFarCents: spent,
      thresholdCents: policy.spendThresholdCents ?? null,
      // Deliberately crude: this run's own cost per completed step, projected
      // over the steps that are left. It is an estimate, presented as one, and
      // better than showing nothing — but it is not a forecast, and a real
      // per-step cost model belongs with the trace work (AGENT-4).
      estimatedRemainingCents: done === 0 ? 0 : Math.round((spent / done) * remaining),
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
