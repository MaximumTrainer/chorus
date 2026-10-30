import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  ConfigurationError,
  type AnyTool,
  type ExternalRef,
  type Role,
  type Scope,
  type Tool,
  type ToolContext,
} from '@chorus/core'

/**
 * Connector sink tools (INT-4, architecture.md §11.4).
 *
 * The first `external` tools the platform ships. A sink tool is deliberately
 * thin: it validates the model's input, derives a stable idempotency key from
 * it, and hands the write to the `SinkDispatcher` on its context. It performs
 * no write itself and imports no connector — the runtime may not reach
 * `@chorus/connectors` (the dependency rule), so the worker supplies the
 * dispatcher that resolves the workspace's integration and writes through it.
 *
 * Being `external` is the whole point: the registry refuses to run one without
 * `before_external_write`, and the AGENT-5 AC2 enumeration gate asserts that of
 * every shipped tool — so a sink tool cannot be added ungated.
 */

/** The external object a sink write resolves to, as a sink tool returns it. */
const ExternalRefSchema = z.object({
  externalId: z.string().min(1),
  url: z.string().optional(),
})

export interface SinkToolSpec<I> {
  /** The agent-facing tool name, e.g. `create_issue`. Plain snake_case. */
  readonly name: string
  readonly description: string
  /** The sink action to dispatch; defaults to `name` when the two match. */
  readonly action?: string
  readonly input: z.ZodType<I>
  readonly requiredRole: Role
  readonly requiredScopes: readonly Scope[]
}

/** A stable digest of a validated input, so a retry of the same write matches. */
function digest(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex').slice(0, 24)
}

/**
 * The idempotency key the connector sees for one logical write.
 *
 * Scoped to the run, because two runs legitimately doing the same thing are two
 * writes, not one — the same reasoning the registry applies to its own in-run
 * dedup. Within a run it is stable across retries, which is what lets the
 * connector's search-before-create collapse a lost-response retry onto the one
 * object it already made.
 */
function dispatchKey(runId: string, action: string, input: unknown): string {
  return `${runId}:${action}:${digest(input)}`
}

export function createSinkTool<I>(spec: SinkToolSpec<I>): Tool<I, ExternalRef> {
  const action = spec.action ?? spec.name
  return {
    name: spec.name,
    description: spec.description,
    input: spec.input,
    output: ExternalRefSchema as unknown as z.ZodType<ExternalRef>,
    sideEffect: 'external',
    requiredRole: spec.requiredRole,
    requiredScopes: spec.requiredScopes,
    // The registry prefixes this with the run id and the tool name, so the
    // content digest alone makes a retry of the same write collapse in-run.
    idempotencyKey: (input) => digest(input),
    async execute(input, ctx: ToolContext): Promise<ExternalRef> {
      if (!ctx.sinkDispatcher) {
        // A deployment that registered the tool but wired no dispatcher cannot
        // write. Refused loudly rather than silently returning nothing, which
        // would read as a successful write that never happened.
        throw new ConfigurationError(`No sink dispatcher is wired for "${spec.name}"`, {
          tool: spec.name,
        })
      }
      return ctx.sinkDispatcher.dispatch(
        { action, input, idempotencyKey: dispatchKey(ctx.runId, action, input) },
        ctx,
      )
    },
  }
}

/** The tracker sink actions named in the §17.1 catalogue (INT-4). */
export function trackerSinkTools(): readonly AnyTool[] {
  const criteria = z.array(z.string()).optional()
  return [
    createSinkTool({
      name: 'create_issue',
      description:
        'Create an issue in the team’s connected tracker. Returns the created issue’s id and url. ' +
        'Idempotent: a retry with the same content resolves to the one issue.',
      input: z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        acceptanceCriteria: criteria,
      }),
      requiredRole: 'member',
      requiredScopes: ['write:artefacts'],
    }),
    createSinkTool({
      name: 'update_issue',
      description: 'Update an existing tracker issue’s title or description.',
      input: z.object({
        issueId: z.string().min(1),
        title: z.string().optional(),
        description: z.string().optional(),
      }),
      requiredRole: 'member',
      requiredScopes: ['write:artefacts'],
    }),
    createSinkTool({
      name: 'transition_issue',
      description: 'Move a tracker issue to a target status, mirroring a task’s state.',
      action: 'transition',
      input: z.object({ issueId: z.string().min(1), status: z.string().min(1) }),
      requiredRole: 'member',
      requiredScopes: ['write:artefacts'],
    }),
    createSinkTool({
      name: 'comment_issue',
      description: 'Post a comment on a tracker issue. Idempotent on a retry with the same body.',
      action: 'comment',
      input: z.object({ issueId: z.string().min(1), body: z.string().min(1) }),
      requiredRole: 'member',
      requiredScopes: ['write:artefacts'],
    }),
  ] as unknown as AnyTool[]
}
