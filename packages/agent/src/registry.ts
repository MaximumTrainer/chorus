import {
  ConfigurationError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  atLeast,
  type AnyTool,
  type Tool,
  type ToolContext,
} from '@chorus/core'

/**
 * The typed tool registry (AGENT-5, architecture.md §11.4).
 *
 * This is where an agent's blast radius is decided, and every rule here is about
 * refusing something. A tool that runs when it should not is the failure with
 * consequences outside the system: an issue in someone's tracker, a message in
 * their channel, a pull request on their repository. A tool that fails to run
 * is an error message.
 *
 * One principle underneath all of it: **an agent is not a privileged actor.** It
 * acts for a person, with exactly that person's authority, through a list of
 * tools its workflow declared in advance. Every check below is that sentence
 * made enforceable.
 */

/** A refusal, distinct from a failure: the tool did not run, and should not have. */
export class ToolRefusedError extends ForbiddenError {
  override readonly type = 'tool_refused'
}

export interface InvokeOptions {
  /**
   * The workflow's allow-list. Not a suggestion: a tool absent from it is
   * refused before execution, so a prompt-injected instruction to use one
   * cannot widen what the workflow can do.
   */
  readonly allowed: readonly string[]
  /**
   * Whether `before_external_write` has been passed for this call.
   *
   * Required for any `external` tool. Defaulting it to true anywhere would make
   * the gate advisory, so it is absent by default and the caller must say so.
   */
  readonly externalWriteApproved?: boolean
}

export interface ToolRegistry {
  list(): readonly AnyTool[]
  get(name: string): AnyTool | undefined
  /**
   * `O` only: the input is `unknown` because it comes from a model, and the
   * caller learns its shape from the tool's schema rather than asserting one.
   */
  invoke<O>(name: string, input: unknown, ctx: ToolContext, options: InvokeOptions): Promise<O>
}

/**
 * The context a tool actually receives.
 *
 * Rebuilt rather than passed through, so a caller cannot smuggle anything extra
 * in. A tool is the part of the system a model steers, and what it can reach is
 * what a prompt-injected instruction can reach.
 */
function toolContextFrom(ctx: ToolContext): ToolContext {
  return {
    workspaceId: ctx.workspaceId,
    teamId: ctx.teamId,
    runId: ctx.runId,
    actor: ctx.actor,
    now: ctx.now,
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
  }
}

export function createToolRegistry(tools: readonly AnyTool[]): ToolRegistry {
  const byName = new Map<string, AnyTool>()

  for (const tool of tools) {
    if (byName.has(tool.name)) {
      // Two tools with one name means whichever loaded last wins, and which one
      // that is depends on import order — a difference between environments
      // that nothing would report.
      throw new ConfigurationError(`Two tools are registered as "${tool.name}"`, {
        tool: tool.name,
      })
    }
    if (tool.sideEffect === 'external' && !tool.idempotencyKey) {
      // Refused at registration, not at invocation. An external tool that
      // cannot describe its own identity cannot be retried safely, and finding
      // that out during an incident is finding it out too late.
      throw new ConfigurationError(
        `Tool "${tool.name}" writes externally and must declare an idempotencyKey`,
        { tool: tool.name },
      )
    }
    byName.set(tool.name, tool)
  }

  /**
   * Results already produced in this run, by idempotency key.
   *
   * Scoped to the run: two runs legitimately doing the same thing must both do
   * it, and collapsing them would make re-running a workflow silently a no-op.
   */
  const completed = new Map<string, unknown>()

  return {
    list: () => [...byName.values()],
    get: (name) => byName.get(name),

    async invoke<O>(
      name: string,
      input: unknown,
      ctx: ToolContext,
      options: InvokeOptions,
    ): Promise<O> {
      const tool = byName.get(name) as Tool<unknown, O> | undefined
      if (!tool) {
        // A workflow allow-listing a tool that does not exist is a definition
        // bug. Treating the allow-list as sufficient would run nothing and
        // report success.
        throw new NotFoundError(`Tool "${name}" is not registered`, { tool: name })
      }

      if (!options.allowed.includes(name)) {
        throw new ToolRefusedError(
          `Tool "${name}" is not in this workflow's allow-list`,
          { tool: name, allowed: [...options.allowed] },
        )
      }

      // The actor's own role, never a role the run acquired. AGENT-5 AC5: "ask
      // the agent to do it" must not be a privilege-escalation path that looks
      // like a feature.
      if (!atLeast(ctx.actor.role, tool.requiredRole)) {
        throw new ToolRefusedError(
          `Tool "${name}" requires the ${tool.requiredRole} role`,
          { tool: name, required: tool.requiredRole, held: ctx.actor.role },
        )
      }

      if (tool.sideEffect === 'external' && options.externalWriteApproved !== true) {
        throw new ToolRefusedError(
          `Tool "${name}" writes externally and has not passed before_external_write`,
          { tool: name, checkpoint: 'before_external_write' },
        )
      }

      // A model will eventually produce input that is wrong. Validated at the
      // boundary rather than trusted, and before any side effect.
      const parsedInput = tool.input.safeParse(input)
      if (!parsedInput.success) {
        throw new ValidationError(
          `Tool "${name}" was given invalid input: ${parsedInput.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
            .join('; ')}`,
          { tool: name },
        )
      }

      const key = tool.idempotencyKey
        ? `${ctx.runId}:${name}:${tool.idempotencyKey(parsedInput.data)}`
        : undefined

      if (key && completed.has(key)) {
        // Returns the first result rather than failing: from the caller's point
        // of view the work is done, and a retried step must not open a second
        // pull request.
        return completed.get(key) as O
      }

      const output = await tool.execute(parsedInput.data, toolContextFrom(ctx))

      // Checked too, because a tool returning a shape its schema forbids is a
      // bug that otherwise surfaces three steps later as something
      // inexplicable.
      const parsedOutput = tool.output.safeParse(output)
      if (!parsedOutput.success) {
        throw new ValidationError(
          `Tool "${name}" returned output that does not match its schema: ${parsedOutput.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
            .join('; ')}`,
          { tool: name },
        )
      }

      if (key) completed.set(key, parsedOutput.data)
      return parsedOutput.data
    },
  }
}
