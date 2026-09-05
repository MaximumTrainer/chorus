import { createHash } from 'node:crypto'
import {
  ConfigurationError,
  DEFAULT_REDACTION_LEVEL,
  NotFoundError,
  ValidationError,
  redactBody,
  resolveCheckpointPolicy,
  ulid,
  type CheckpointKind,
  type NotificationSink,
  type PolicyRule,
  type ArtefactDraft,
  type ArtefactWriter,
  type RedactionLevel,
  type Retriever,
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
import { fillPrompt } from '@chorus/llm'
import type { ModelProvider, ModelRef } from '@chorus/llm'
import { withSpan } from '@chorus/telemetry'
import { issueDecisionToken } from './decision-links.js'
import { routingEvent, type RoutingDecision } from './router.js'
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
  /**
   * Where a "needs a human" event goes (SLACK-6, plan.md §2.1).
   *
   * A `NotificationSink` from `core`, not the notifications package: the
   * runtime raises an abstract event and knows nothing about inboxes, mail or
   * chat. Optional, because a run must still pause correctly in a deployment
   * that has told nobody how to reach anyone — the gate is what stops the run,
   * and the notification is what makes it answerable.
   */
  readonly notify?: NotificationSink['notify']
  /**
   * Where a step's prompt is loaded from (AGENT-4 AC2).
   *
   * Optional only until every workflow has its prompts on disk; a model call
   * whose template cannot be named is one whose result cannot be reproduced,
   * and the trace says so rather than pretending otherwise.
   */
  readonly prompts?: PromptSource
  /**
   * Where a `retrieve` step gets its context (BRAIN-4).
   *
   * One implementation, shared with chat, MCP and search — which is what makes
   * "no path leaks content a user cannot see" assertable once rather than per
   * caller.
   */
  readonly retriever?: Retriever
  /**
   * Where an `emit` step writes (AGENT-1, architecture.md §11.7).
   *
   * An `ArtefactWriter` from `core`, so the runtime describes an artefact and
   * the API decides how that becomes rows — a workflow handing over a partial
   * database record would make every schema change a workflow change.
   */
  readonly artefacts?: ArtefactWriter
  /**
   * What a call cost, in whole cents.
   *
   * Injected because pricing is deployment configuration, not a fact about the
   * code — and because a hard-coded price is wrong the week after it is
   * written. Absent means zero, which keeps the ledger's *shape* correct while
   * a deployment has told it nothing about money.
   */
  readonly priceFor?: (model: ModelRef, usage: { inputTokens: number; outputTokens: number }) => number
}

/** The narrow slice of a prompt registry the executor needs. */
export interface PromptSource {
  get(id: string): { readonly body: string; readonly version: number; readonly hash: string }
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
  | {
      readonly kind: 'output'
      readonly output: unknown
      /** Step ids this step has decided against — a branch's other arm. */
      readonly disable?: readonly string[]
    }
  | { readonly kind: 'pause' }
  | { readonly kind: 'stop'; readonly reason: string }

export interface StartInput {
  readonly workspaceId: string
  readonly teamId: string
  readonly startedBy: string
  readonly definition: WorkflowDefinition
  readonly input: Readonly<Record<string, unknown>>
  /**
   * How this workflow came to be chosen (AGENT-2 AC4).
   *
   * Optional: a scheduled run of a named workflow had nothing to decide. When
   * present it is written as the run's *first* event, before anything the run
   * does — a trace that explains every step but not how the run came to be
   * this workflow answers the wrong question.
   */
  readonly routing?: RoutingDecision
}

export interface Executor {
  start(input: StartInput): Promise<RunRecord>
  run(workspaceId: string, runId: string): Promise<RunOutcome>
}

/**
 * A reference scope: `"gather.output"`, `"each.item"`, `"each.index"`.
 *
 * Keyed by the whole reference rather than by step id, so a loop's per-iteration
 * values live in the same lookup as step outputs and one substitution rule
 * covers both.
 */
type Scope = Readonly<Record<string, unknown>>

const REFERENCE = /\{\{\s*([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\s*\}\}/g

/** Every `{{id.field}}` this step mentions, anywhere in its definition. */
function referencesOf(step: WorkflowStep): string[] {
  const found = new Set<string>()
  for (const match of JSON.stringify(step).matchAll(REFERENCE)) found.add(match[1]!)
  return [...found].sort()
}

/**
 * What a step's work depends on.
 *
 * Its own definition, plus **only the values it actually reads**. Hashing the
 * whole accumulated scope instead is the obvious implementation and it is
 * wrong: every earlier step's output is in that scope by the time a later step
 * runs, so on resume the first step's hash no longer matches what was recorded
 * — and the executor re-runs everything, which is precisely the duplicate
 * external write AC2 exists to prevent.
 *
 * A step whose upstream output genuinely changed is different work and must run
 * again; one whose own inputs are identical has already been done. Inside a
 * loop this is also what makes each iteration distinct work: the body's
 * definition is the same every time, but `{{each.item}}` is not.
 */
function hashInput(step: WorkflowStep, scope: Scope): string {
  const relevant: Record<string, unknown> = {}
  for (const reference of referencesOf(step)) relevant[reference] = scope[reference]

  return createHash('sha256')
    .update(JSON.stringify({ step, inputs: relevant }))
    .digest('hex')
}

/**
 * Substitutes `{{id.field}}` references, at any depth.
 *
 * Deliberately minimal — the walking skeleton's lesson is that a template
 * language grows teeth. A reference resolves to a value already in scope or it
 * is left alone; there is no expression evaluation, so a definition cannot
 * compute. It recurses into objects and arrays because a step's input is
 * usually a shape like `{ item: '{{each.item}}' }`, and substituting only at
 * the top level would hand the tool the literal braces.
 */
function resolve(value: unknown, scope: Scope): unknown {
  if (typeof value === 'string') {
    // A string that is *only* a reference resolves to the value itself, so a
    // structured output does not get flattened into its own JSON text.
    const whole = /^\{\{\s*([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\s*\}\}$/.exec(value)
    if (whole) return scope[whole[1]!]
    return value.replace(REFERENCE, (original, reference: string) => {
      const found = scope[reference]
      if (found === undefined) return original
      return typeof found === 'string' ? found : JSON.stringify(found)
    })
  }

  if (Array.isArray(value)) return value.map((entry) => resolve(entry, scope))

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        resolve(entry, scope),
      ]),
    )
  }

  return value
}

/**
 * Whether a branch's condition is satisfied.
 *
 * Spelled out rather than left to JavaScript truthiness, because the values
 * reaching it come from tools and models: an empty list, an empty string and
 * the string `"false"` all read as true under `!!`, and each of those is a case
 * where a workflow author plainly meant the other arm.
 */
function isSatisfied(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value !== '' && value.toLowerCase() !== 'false'
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    // A tool answering a yes/no question conventionally returns `{ ok: … }` or
    // `{ result: … }`; honouring those beats making every workflow unwrap them.
    if ('ok' in record) return isSatisfied(record.ok)
    if ('result' in record) return isSatisfied(record.result)
    return Object.keys(record).length > 0
  }
  return Boolean(value)
}

/** The list a loop iterates, or undefined if the value is not one. */
function collectionFrom(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    // A tool returning a list conventionally wraps it: `{ items: [...] }`.
    if (Array.isArray(record.items)) return record.items
    if (Array.isArray(record.results)) return record.results
  }
  return undefined
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
    async start({ workspaceId, teamId, startedBy, definition, input, routing }) {
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

        if (routing) {
          // Seq 1, inside the same transaction that created the run: a run that
          // exists without the decision that produced it is a trace with its
          // first question unanswerable.
          await t.execute(
            `INSERT INTO run_events (id, workspace_id, run_id, seq, kind, payload)
             VALUES ($1, $2, $3, 1, 'routing', $4)`,
            [ulid(), workspaceId, id, JSON.stringify(routingEvent(routing))],
          )
        }
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

      /** Per-iteration values a loop publishes, e.g. `each.item`. */
      const items: Record<string, unknown> = {}
      /**
       * What the run was started with, addressable as `{{input.<name>}}`.
       *
       * A definition declares `inputs`; without this the declaration is
       * decoration, and every workflow needs a first step whose only job is to
       * restate the request its caller already made. Read from the trigger
       * rather than held in memory so a resumed run sees the same values it
       * started with — the alternative is a run that resumes against different
       * inputs and reports success.
       */
      const startedWith = run.trigger?.input ?? {}

      const scope = (): Scope => ({
        ...Object.fromEntries(
          Object.entries(startedWith).map(([name, value]) => [`input.${name}`, value]),
        ),
        ...Object.fromEntries(Object.entries(outputs).map(([id, value]) => [`${id}.output`, value])),
        ...items,
      })

      const stepsById = new Map(definition.steps.map((step) => [step.id, step]))

      // A loop's body steps appear in `steps` like any other, because that is
      // where their definitions live. Running them once for the loop and again
      // in sequence is the obvious implementation and is wrong, so the main
      // pass skips anything a loop owns.
      const ownedByLoop = new Set<string>()
      for (const step of definition.steps) {
        if (step.type === 'loop') for (const body of step.body) ownedByLoop.add(body)
      }

      // Steps a branch decided against. Rebuilt from each branch's recorded
      // output rather than re-evaluated, so a resumed run takes the arm it took
      // the first time even if the condition would now read differently.
      const disabled = new Set<string>()
      for (const [stepId, row] of done) {
        if (stepsById.get(stepId)?.type !== 'branch' || row.status !== 'succeeded') continue
        for (const id of (row.output as { disabled?: string[] } | null)?.disabled ?? []) {
          disabled.add(id)
        }
      }

      await tx(workspaceId, (t) =>
        t.execute(`UPDATE runs SET status = 'running' WHERE id = $1`, [runId]),
      )

      let executed = 0
      let skipped = 0
      let seq = done.size
      const actorRole = await roleOf(workspaceId, run.started_by)
      // Read once per run, not per call: the policy in force is the one the run
      // started under, so a change mid-run cannot make half a trace unreadable
      // against the other half.
      const redaction = await redactionLevelOf(workspaceId)

      type StepOutcome =
        | { kind: 'ran'; output: unknown; disable?: readonly string[] }
        | { kind: 'cached'; output: unknown }
        | { kind: 'pause' }
        | { kind: 'stop'; reason: string }
        | { kind: 'failed'; message: string }

      /**
       * Runs one step and records it, or reports that it did not need to run.
       *
       * `recordAs` is the identity the run remembers it by. That is the step's
       * own id everywhere except inside a loop, where each iteration needs a
       * distinct one — resumption matches by step id, and two iterations
       * sharing one could not be told apart.
       */
      const runStep = async (step: WorkflowStep, recordAs: string): Promise<StepOutcome> => {
        const inputHash = hashInput(step, scope())
        const previous = done.get(recordAs)

        // The whole of AC2's "re-executes nothing": same step, same inputs,
        // already succeeded.
        if (previous?.status === 'succeeded' && previous.input_hash === inputHash) {
          return { kind: 'cached', output: previous.output }
        }

        seq += 1
        await tx(workspaceId, (t) =>
          t.execute(
            `INSERT INTO run_steps
               (id, workspace_id, run_id, seq, step_id, step_type, input_hash, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'running')
             ON CONFLICT (run_id, step_id) DO UPDATE
               SET seq = EXCLUDED.seq, input_hash = EXCLUDED.input_hash,
                   status = 'running', error = NULL, started_at = now()`,
            [ulid(), workspaceId, runId, seq, recordAs, step.type, inputHash],
          ),
        )

        try {
          const result = await withSpan(
            `agent.step.${step.type}`,
            {
              'chorus.workspace_id': workspaceId,
              'chorus.run_id': runId,
              'chorus.step_id': recordAs,
              'chorus.workflow': `${definition.name}@${definition.version}`,
            },
            () =>
              executeStep({
                step,
                definition,
                redaction,
                scope: scope(),
                outputs,
                startedWith,
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
            await tx(workspaceId, (t) =>
              t.execute(
                `UPDATE run_steps SET status = 'waiting' WHERE run_id = $1 AND step_id = $2`,
                [runId, recordAs],
              ),
            )
            return { kind: 'pause' }
          }

          if (result.kind === 'stop') {
            await tx(workspaceId, (t) =>
              t.execute(
                `UPDATE run_steps SET status = 'skipped', finished_at = now()
                  WHERE run_id = $1 AND step_id = $2`,
                [runId, recordAs],
              ),
            )
            return { kind: 'stop', reason: result.reason }
          }

          await tx(workspaceId, (t) =>
            t.execute(
              `UPDATE run_steps SET status = 'succeeded', output = $1, finished_at = now()
                WHERE run_id = $2 AND step_id = $3`,
              [JSON.stringify(result.output ?? null), runId, recordAs],
            ),
          )
          return {
            kind: 'ran',
            output: result.output,
            ...(result.disable ? { disable: result.disable } : {}),
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)

          await tx(workspaceId, async (t) => {
            await t.execute(
              `UPDATE run_steps SET status = 'failed', error = $1, finished_at = now()
                WHERE run_id = $2 AND step_id = $3`,
              [message, runId, recordAs],
            )
            await t.execute(
              `INSERT INTO run_events (id, workspace_id, run_id, seq, kind, payload)
               VALUES ($1, $2, $3, $4, 'error', $5)`,
              [ulid(), workspaceId, runId, seq, JSON.stringify({ step: recordAs, message })],
            )
          })
          return { kind: 'failed', message }
        }
      }

      const endRun = async (status: 'failed' | 'stopped', reason: string): Promise<RunOutcome> => {
        await tx(workspaceId, (t) =>
          t.execute(`UPDATE runs SET status = $1, error = $2, finished_at = now() WHERE id = $3`, [
            status,
            reason,
            runId,
          ]),
        )
        // Both recorded: the run says why it ended, the step says which one and
        // how, so an ending is diagnosable without reading the logs.
        return { runId, status, stepsExecuted: executed, stepsSkipped: skipped, error: reason }
      }

      const pauseRun = async (): Promise<RunOutcome> => {
        await tx(workspaceId, (t) =>
          t.execute(`UPDATE runs SET status = 'waiting_human' WHERE id = $1`, [runId]),
        )
        return { runId, status: 'waiting_human', stepsExecuted: executed, stepsSkipped: skipped }
      }

      /** Records a step the run reached but deliberately did not execute. */
      const markSkipped = async (stepId: string, stepType: string): Promise<void> => {
        seq += 1
        await tx(workspaceId, (t) =>
          t.execute(
            `INSERT INTO run_steps
               (id, workspace_id, run_id, seq, step_id, step_type, input_hash, status, finished_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'not-run', 'skipped', now())
             ON CONFLICT (run_id, step_id) DO UPDATE
               SET status = 'skipped', finished_at = now()`,
            [ulid(), workspaceId, runId, seq, stepId, stepType],
          ),
        )
      }

      /**
       * A loop over a collection an earlier step produced.
       *
       * The bound is not defensive tidiness: the collection usually came from a
       * model, and a model asked for "the tasks" can return a thousand. Silently
       * processing the first twenty would be a wrong answer presented as a right
       * one, so exceeding the bound fails the run instead.
       */
      const runLoop = async (
        step: Extract<WorkflowStep, { type: 'loop' }>,
      ): Promise<
        { kind: 'done' } | { kind: 'pause' } | { kind: 'stop'; reason: string } | { kind: 'failed'; message: string }
      > => {
        const collection = collectionFrom(resolve(step.over, scope()))

        if (collection === undefined) {
          return {
            kind: 'failed',
            message:
              `Step "${step.id}" loops over ${step.over}, which did not resolve to a list. ` +
              `Guessing at one would iterate over something arbitrary.`,
          }
        }

        if (collection.length > step.maxIterations) {
          return {
            kind: 'failed',
            message:
              `Step "${step.id}" would run ${collection.length} iterations, over its ` +
              `maxIterations of ${step.maxIterations}. Truncating would silently drop work.`,
          }
        }

        const perIteration: unknown[] = []

        for (const [index, item] of collection.entries()) {
          items[`${step.id}.item`] = item
          items[`${step.id}.index`] = index

          for (const bodyId of step.body) {
            const body = stepsById.get(bodyId)
            // Load-time validation catches this. The check is here because a
            // definition stored before that validation existed would otherwise
            // fail on an undefined, which says nothing useful.
            if (!body) return { kind: 'failed', message: `Step "${bodyId}" is not a step` }

            const outcome = await runStep(body, `${bodyId}#${index}`)
            if (outcome.kind === 'failed' || outcome.kind === 'stop' || outcome.kind === 'pause') {
              return outcome
            }
            if (outcome.kind === 'ran') executed += 1
            else skipped += 1
            outputs[bodyId] = outcome.output
            perIteration.push(outcome.output)
          }
        }

        delete items[`${step.id}.item`]
        delete items[`${step.id}.index`]

        // The loop is itself a step and records what it did. Written directly
        // rather than through runStep, because a loop has no work of its own to
        // execute — its work is the iterations, which have already happened.
        seq += 1
        await tx(workspaceId, (t) =>
          t.execute(
            `INSERT INTO run_steps
               (id, workspace_id, run_id, seq, step_id, step_type, input_hash, status, output,
                finished_at)
             VALUES ($1, $2, $3, $4, $5, 'loop', $6, 'succeeded', $7, now())
             ON CONFLICT (run_id, step_id) DO UPDATE
               SET seq = EXCLUDED.seq, input_hash = EXCLUDED.input_hash, status = 'succeeded',
                   output = EXCLUDED.output, error = NULL, finished_at = now()`,
            [
              ulid(),
              workspaceId,
              runId,
              seq,
              step.id,
              hashInput(step, scope()),
              JSON.stringify(perIteration),
            ],
          ),
        )
        outputs[step.id] = perIteration
        // A loop is a step that ran, and AC4 admits no exceptions: a hook a
        // workflow has to opt into is one the fourth workflow forgets, and an
        // evaluation harness then reports on a subset and looks healthy.
        await recordEvent(workspaceId, runId, 'tool_call', {
          step: step.id,
          iterations: collection.length,
        })
        return { kind: 'done' }
      }

      for (const step of definition.steps) {
        if (ownedByLoop.has(step.id)) continue

        if (disabled.has(step.id)) {
          // Recorded, not merely absent: a trace unable to distinguish "the
          // branch went the other way" from "this step was never in the
          // definition" gives the worse of the two answers to someone reading
          // the run months later.
          await markSkipped(step.id, step.type)
          skipped += 1
          continue
        }

        if (step.type === 'loop') {
          const outcome = await runLoop(step)
          if (outcome.kind === 'failed') return endRun('failed', outcome.message)
          if (outcome.kind === 'stop') return endRun('stopped', outcome.reason)
          if (outcome.kind === 'pause') return pauseRun()
          continue
        }

        const outcome = await runStep(step, step.id)

        if (outcome.kind === 'pause') return pauseRun()
        // Stopped, not failed. A policy of `never`, a rejection or an expiry
        // are all the system working as asked; recording them as failures would
        // put healthy runs in an error dashboard.
        if (outcome.kind === 'stop') return endRun('stopped', outcome.reason)
        if (outcome.kind === 'failed') return endRun('failed', outcome.message)

        outputs[step.id] = outcome.output
        if (outcome.kind === 'cached') skipped += 1
        else executed += 1

        // A branch decides for steps it does not itself contain, so its verdict
        // has to outlive it — taken from the recorded output on a resume, and
        // from the fresh one here.
        const verdict =
          outcome.kind === 'cached'
            ? ((outcome.output as { disabled?: string[] } | null)?.disabled ?? [])
            : (outcome.disable ?? [])
        for (const id of verdict) disabled.add(id)
      }

      await tx(workspaceId, (t) =>
        t.execute(`UPDATE runs SET status = 'succeeded', finished_at = now() WHERE id = $1`, [
          runId,
        ]),
      )
      return { runId, status: 'succeeded', stepsExecuted: executed, stepsSkipped: skipped }
    },
  }

  /**
   * Keys for one redacted body, prefixed by what it is.
   *
   * Spread rather than assigned, so a level that keeps nothing contributes no
   * keys at all — a key holding `undefined` would read, to anyone querying the
   * trace, as a body that was there and empty.
   */
  function prefixed(
    name: 'prompt' | 'response',
    redacted: { body?: string; hash?: string; length?: number },
  ): Record<string, unknown> {
    return {
      ...(redacted.body === undefined ? {} : { [name]: redacted.body }),
      ...(redacted.hash === undefined ? {} : { [`${name}Hash`]: redacted.hash }),
      ...(redacted.length === undefined ? {} : { [`${name}Length`]: redacted.length }),
    }
  }

  async function redactionLevelOf(workspaceId: string): Promise<RedactionLevel> {
    const [row] = await tx(workspaceId, (t) =>
      t.query<{ redaction_level: RedactionLevel }>(
        `SELECT redaction_level FROM workspaces WHERE id = $1`,
        [workspaceId],
      ),
    )
    return row?.redaction_level ?? DEFAULT_REDACTION_LEVEL
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
    /** In force for this run, applied as each event is written. */
    redaction: RedactionLevel
    /** Every `{{id.field}}` value visible to this step. */
    scope: Scope
    outputs: Record<string, unknown>
    /** What the run was started with, so a prompt can name its inputs. */
    startedWith: Readonly<Record<string, unknown>>
    workspaceId: string
    teamId: string
    runId: string
    actor: { userId: string; role: 'member' | 'senior_member' | 'admin' | 'owner' }
  }): Promise<StepResult> {
    const { step, definition, redaction, scope, outputs, startedWith, workspaceId, teamId, runId, actor } =
      input
    const ctx = { workspaceId, teamId, runId, actor, now }

    switch (step.type) {
      case 'tool': {
        const result = await deps.registry.invoke(
          step.tool,
          resolve(step.input, scope) ?? {},
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

        // AC2: the exact template, by version and hash. The file will change,
        // and a result has to be replayable against the text that produced it
        // rather than against whatever the file says today.
        const template = deps.prompts?.get(step.prompt)
        // The run's inputs first, then step outputs — a step id and an input
        // sharing a name means the step, which is the later and more specific
        // fact. The first step of a workflow is usually a model call with no
        // earlier step to read from, so a prompt that cannot name what the run
        // was started with forces every workflow to carry a step whose only
        // job is to copy the request somewhere the prompt can see it.
        const visible = { ...startedWith, ...outputs }
        const content = template
          ? renderTemplate(step.prompt, template.body, visible)
          : renderPrompt(step.prompt, visible)

        const startedAt = Date.now()
        let text = ''
        let usage = { inputTokens: 0, outputTokens: 0 }

        for await (const event of deps.models.stream({
          model,
          messages: [{ role: 'user', content }],
          context: { workspaceId, teamId, runId, purpose: 'chat' },
        })) {
          if (event.type === 'token') text += event.text
          // Usage arrives with `done` precisely so a stream cannot end without
          // reporting what it cost — a gap here is unreconstructable later.
          if (event.type === 'done') usage = event.usage
          if (event.type === 'error') throw new Error(event.message)
        }

        const latencyMs = Date.now() - startedAt
        const costCents = deps.priceFor
          ? deps.priceFor(model, usage)
          : 0

        // Written as the call happens, not at run completion: a crashed run's
        // spend is still spend, and buffering loses exactly the case where
        // somebody wants to know where the money went.
        await tx(workspaceId, async (t) => {
          await t.execute(
            `INSERT INTO spend_ledger
               (id, workspace_id, team_id, run_id, provider, model, purpose,
                tokens_in, tokens_out, cost_cents, latency_ms)
             VALUES ($1, $2, $3, $4, $5, $6, 'chat', $7, $8, $9, $10)`,
            [
              ulid(),
              workspaceId,
              teamId || null,
              runId,
              model.provider,
              model.model,
              usage.inputTokens,
              usage.outputTokens,
              costCents,
              latencyMs,
            ],
          )
          // `runs` carries a cache of the sum, kept in the same transaction as
          // the row it sums — a cache that can disagree with its source is a
          // number nobody can defend.
          await t.execute(
            `UPDATE runs
                SET cost_cents = cost_cents + $2,
                    tokens_in = tokens_in + $3,
                    tokens_out = tokens_out + $4
              WHERE id = $1`,
            [runId, costCents, usage.inputTokens, usage.outputTokens],
          )
        })

        await recordEvent(
          workspaceId,
          runId,
          'model_call',
          {
            step: step.id,
            provider: model.provider,
            model: model.model,
            // `promptPath`, not `prompt`: the body claims that name when the
            // redaction level retains it, and one key meaning "the template we
            // used" in some runs and "what we actually sent" in others makes
            // every consumer of the trace guess.
            promptPath: step.prompt,
            // Named for what they are. `promptHash` alone collided with the
            // hash of the body the redaction policy contributes, and one key
            // meaning "the template" in some runs and "what we sent" in others
            // is a trace that cannot be queried without reading the code that
            // wrote it.
            ...(template
              ? {
                  promptTemplateId: step.prompt,
                  promptTemplateVersion: template.version,
                  promptTemplateHash: template.hash,
                }
              : {}),
            tokensIn: usage.inputTokens,
            tokensOut: usage.outputTokens,
            costCents,
            latencyMs,
            // Applied here, at write time. A filter over stored content is a
            // promise that every future reader remembers to apply it; a body
            // that was never written cannot be leaked by a query somebody
            // writes next year, or by a backup restored somewhere else.
            ...prefixed('prompt', redactBody(redaction, content)),
            ...prefixed('response', redactBody(redaction, text)),
          },
          template
            ? { id: step.prompt, version: template.version, hash: template.hash }
            : undefined,
        )
        return { kind: 'output', output: text }
      }

      case 'retrieve': {
        if (!deps.retriever) {
          // Refusing beats retrieving nothing and calling it an empty result: a
          // workflow whose grounding silently vanished produces a confident
          // answer from no evidence, which is the worst failure this system has.
          throw new ConfigurationError(
            `Step "${step.id}" retrieves, but no retriever is configured for this runtime.`,
            { step: step.id },
          )
        }

        const bundle = await deps.retriever.retrieve({
          query: String(resolve(step.query, scope) ?? step.query),
          workspaceId,
          teamId,
          // Retrieval is filtered against the person the run acts for, never
          // the platform. An agent is not a privileged actor (AGENT-5 AC5), and
          // that has to hold for what it can *read* as much as what it can do.
          userId: actor.userId,
          k: step.limit,
          expand: step.expand as 0 | 1 | 2,
          ...(step.kinds.length > 0
            ? { kinds: step.kinds as readonly ['code'][number][] }
            : {}),
        })

        // Persisted, so the "Context used" panel is exact rather than
        // reconstructed (CHAT-3), and so a run can be replayed against the
        // evidence it actually had.
        await deps.retriever.persist(workspaceId, bundle)

        await recordEvent(workspaceId, runId, 'tool_call', {
          step: step.id,
          retrieval: {
            bundleId: bundle.id,
            considered: bundle.considered,
            returned: bundle.fragments.length,
          },
        })

        return { kind: 'output', output: bundle }
      }

      case 'branch': {
        // The verdict is recorded as the step's output, not held in memory, so
        // a resumed run takes the arm it took the first time rather than
        // re-deciding against a world that has since moved on.
        const satisfied = isSatisfied(resolve(step.when, scope))
        const disable = satisfied ? step.otherwise : step.then

        await recordEvent(workspaceId, runId, 'routing', {
          step: step.id,
          taken: satisfied ? 'then' : 'otherwise',
          disabled: disable,
        })

        return {
          kind: 'output',
          output: { taken: satisfied ? 'then' : 'otherwise', disabled: [...disable] },
          disable,
        }
      }

      case 'emit': {
        if (!deps.artefacts) {
          // Refusing beats pretending. A workflow whose emit silently did
          // nothing would report success having produced no artefact, and the
          // person who asked for a document would go looking for one.
          throw new ConfigurationError(
            `Step "${step.id}" emits a ${step.artefact}, but no artefact writer is configured.`,
            { step: step.id, artefact: step.artefact },
          )
        }

        const draft = draftFrom(step.artefact, outputs)
        if (!draft) {
          throw new ValidationError(
            `Step "${step.id}" found nothing to emit as a ${step.artefact}. ` +
              `An emit step reads the output of an earlier step; none of them produced one.`,
            { step: step.id, artefact: step.artefact },
          )
        }

        // Validation lives in the writer and runs *before* the write
        // (§11.7). An artefact written first and checked later has already
        // been seen, linked to and acted on by the time anybody notices it
        // is wrong.
        const emitted = await deps.artefacts.emit(draft, {
          workspaceId,
          teamId,
          runId,
          actorId: actor.userId,
        })

        await recordEvent(workspaceId, runId, 'artefact', {
          step: step.id,
          kind: emitted.kind,
          artefactId: emitted.id,
          title: emitted.title,
          pointers: emitted.pointerCount,
        })

        return { kind: 'output', output: emitted }
      }

      case 'checkpoint':
        return gate({
          step: step.id,
          kind: step.kind,
          definition,
          outputs,
          workspaceId,
          teamId,
          runId,
          startedBy: actor.userId,
        })

      // `loop` never reaches here: it is control flow over other steps, so
      // the run loop owns it. `retrieve` arrives with BRAIN-4 and `emit` with
      // the artefact models. Refusing loudly beats a silent no-op that makes a
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
    startedBy: string
  }): Promise<StepResult> {
    const { step, kind, definition, outputs, workspaceId, teamId, runId, startedBy } = input

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

    if (created?.status === 'pending' && deps.notify) {
      // Minted here, where the recipient and the gate are both known, so the
      // dispatcher stays generic (plan.md §2.1: checkpoint-specific rendering
      // sits on top of the primitive, not inside it). The raw token is never
      // stored — it exists in the email and nowhere else.
      const token = await tx(workspaceId, (t) =>
        issueDecisionToken(t, {
          workspaceId,
          checkpointId: created.id,
          userId: startedBy,
          // The gate's own deadline. A token outliving its checkpoint is a
          // credential for something that can no longer happen.
          expiresAt: new Date(created.expiresAt),
        }),
      )

      // Raised only for a gate that is genuinely waiting. An `auto` checkpoint
      // asks nobody, and telling someone about a decision already made trains
      // them to ignore the ones that are not.
      //
      // After the row exists, so a recipient following the link finds something
      // to act on rather than a race; and outside the insert, because a
      // notification failing must not undo the checkpoint — a gate that
      // vanished because the mail server was down is worse than a silent one.
      await deps.notify({
        workspaceId,
        recipients: [startedBy],
        kind: 'checkpoint_requested',
        subject: `${definition.name}@${definition.version} is waiting for your approval`,
        body:
          `A run of ${definition.name} has stopped at ${kind} and needs a decision ` +
          `before it can continue.`,
        targetType: 'checkpoint',
        targetId: created.id,
        // Urgent by nature: a run is stopped until this is answered, so it must
        // not be swept into a digest (AC5).
        priority: 'urgent',
        // The actionable link when one was minted; the in-app path otherwise,
        // which a recipient who is signed in can still follow.
        path: token
          ? `/checkpoint-decisions/${token}`
          : `/workspaces/${workspaceId}/checkpoints/${created.id}`,
        payload: { runId, step, kind, workflow: `${definition.name}@${definition.version}` },
      })
    }

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
   * The artefact a workflow is proposing, from what its steps produced.
   *
   * An emit step names a *kind*, not a source: `emit: structure_proposal` says
   * what to write, and the material is whatever an earlier step produced. So
   * this walks the outputs backwards and takes the most recent one that looks
   * like an artefact — the last step to have said something is the one that
   * said it.
   *
   * A model step produces a string, and a string is not an artefact. Rather
   * than guessing a title from a paragraph, an unparseable output yields
   * nothing and the step fails with a message naming the step — which is
   * recoverable, where a document titled after the first line of a model's
   * preamble is not.
   */
  function draftFrom(
    artefact: string,
    outputs: Readonly<Record<string, unknown>>,
  ): ArtefactDraft | undefined {
    for (const value of [...Object.values(outputs)].reverse()) {
      const candidate = parseDraft(artefact, value)
      if (candidate) return candidate
    }
    return undefined
  }

  function parseDraft(artefact: string, value: unknown): ArtefactDraft | undefined {
    // A model asked for JSON usually returns JSON, sometimes wrapped in prose.
    // Taking the outermost braces is the smallest thing that handles both
    // without inventing a parser.
    const record =
      typeof value === 'string' ? parseJsonObject(value) : (value as Record<string, unknown>)
    if (!record || typeof record !== 'object') return undefined

    const title = record.title
    if (typeof title !== 'string' || title.trim() === '') return undefined

    const kind: ArtefactDraft['kind'] = artefact === 'task' ? 'task' : 'document'

    return {
      kind,
      title: title.trim(),
      ...(isStringRecord(record.sections) ? { sections: record.sections } : {}),
      ...(isStringArray(record.acceptanceCriteria)
        ? { acceptanceCriteria: record.acceptanceCriteria }
        : {}),
      ...(isStringArray(record.tags) ? { tags: record.tags } : {}),
      ...(Array.isArray(record.pointers)
        ? { pointers: record.pointers as NonNullable<ArtefactDraft['pointers']> }
        : {}),
      ...(typeof record.documentType === 'string'
        ? { documentType: record.documentType }
        : artefact !== 'task'
          ? { documentType: artefact }
          : {}),
    }
  }

  function parseJsonObject(text: string): Record<string, unknown> | undefined {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end <= start) return undefined
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1))
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }

  function isStringRecord(value: unknown): value is Record<string, string> {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string')
    )
  }

  function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
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
    /**
     * Which template produced this, as columns rather than only inside the
     * payload — "every run using prompt X at version N" is a question the
     * evaluation harness will ask, and JSON containment is a poor index.
     */
    prompt?: { id: string; version: number; hash: string },
  ): Promise<void> {
    await tx(workspaceId, async (t) => {
      const [last] = await t.query<{ next: number }>(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = $1`,
        [runId],
      )
      await t.execute(
        `INSERT INTO run_events
           (id, workspace_id, run_id, seq, kind, payload, prompt_id, prompt_version, prompt_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          ulid(),
          workspaceId,
          runId,
          last?.next ?? 1,
          kind,
          JSON.stringify(payload),
          prompt?.id ?? null,
          prompt?.version ?? null,
          prompt?.hash ?? null,
        ],
      )
    })
  }

  /**
   * Substitutes `{{name}}` values into a prompt body.
   *
   * `renderPrompt` in `packages/llm` is the canonical, strict one; this is
   * lenient because a workflow's outputs are not known to match a template's
   * placeholders until the workflows themselves land, and failing a run over a
   * placeholder mismatch would be a worse answer than leaving it visible.
   */
  /**
   * Fills a prompt template from what the run can see.
   *
   * Delegates the placeholder rule to `packages/llm`, which owns what a prompt
   * is. Two definitions of a placeholder means a name one side substitutes and
   * the other passes through untouched, and the symptom is a model asked a
   * question containing `{{documentType}}` — which it answers, plausibly.
   */
  function renderTemplate(
    id: string,
    body: string,
    visible: Readonly<Record<string, unknown>>,
  ): string {
    return fillPrompt(
      { id, body },
      Object.fromEntries(
        Object.entries(visible).map(([name, value]) => [
          name,
          typeof value === 'string' ? value : JSON.stringify(value),
        ]),
      ),
    ).text
  }
}
