import { z } from 'zod'
import type { AnyTool, WorkflowDefinition } from '@chorus/core'
import type { DbConfig } from '@chorus/db'
import { createExecutor, createToolRegistry } from '@chorus/agent'
import type { ModelProvider, ModelRef } from '@chorus/llm'

/**
 * Running one chat turn (CHAT-2).
 *
 * > Showing tool calls inline is what makes it trustworthy — the user sees it
 * > searching the codebase rather than wondering.
 *
 * The turn is a workflow run like every other model call in the system, which
 * is what makes it traceable, replayable and governed by the same checkpoint
 * policies. This is only the part that turns a run into a stream somebody can
 * watch, and an answer that outlives the connection.
 *
 * Injected into the app for the same reason as `resumeRun` and `suggestEdits`:
 * in a deployment the worker executes and the API forwards what it publishes,
 * and a route that ran the workflow inline would tie a browser to however long
 * the rest of it takes. A test passes one that runs inline — the same code, a
 * different transport.
 */

/** What a reader watching a turn is told, as it happens. */
export type TurnEvent =
  | { readonly kind: 'token'; readonly text: string }
  | { readonly kind: 'tool_call'; readonly step: string; readonly tool: string; readonly summary: string }

export interface TurnResult {
  readonly runId: string
  /** The whole answer, for persistence — the stream is not the record. */
  readonly text: string
}

export interface TurnRunner {
  run(
    input: {
      readonly workspaceId: string
      readonly sessionId: string
      readonly teamId: string
      readonly actorId: string
      readonly text: string
    },
    onEvent: (event: TurnEvent) => void,
  ): Promise<TurnResult>
}

/**
 * A tool the turn may call, and how to describe what it did.
 *
 * The summary is declared beside the tool rather than derived in the executor:
 * "found three files" is a fact about what `look_up` returns, and a runtime
 * that guessed it would produce the sort of generic notice a reader learns to
 * ignore.
 */
export interface TurnTool {
  readonly name: string
  readonly summarise: (output: unknown) => string
  readonly execute?: (input: Record<string, unknown>) => Promise<unknown>
}

export function createTurnRunner(
  config: DbConfig,
  deps: {
    readonly models: ModelProvider
    readonly modelFor: (tier: string) => ModelRef
    readonly definition: WorkflowDefinition
    readonly tools?: readonly TurnTool[]
  },
): TurnRunner {
  const summaries = new Map(deps.tools?.map((tool) => [tool.name, tool.summarise]) ?? [])

  const tools: AnyTool[] = (deps.tools ?? []).map(
    (tool) =>
      ({
        name: tool.name,
        description: tool.name,
        input: z.object({}).passthrough(),
        output: z.unknown(),
        sideEffect: 'none',
        requiredRole: 'member',
        requiredScopes: [],
        execute: async (input: Record<string, unknown>) =>
          tool.execute ? tool.execute(input) : { ok: true },
      }) as unknown as AnyTool,
  )

  return {
    async run(input, onEvent) {
      // A fresh executor per turn, because the event sink belongs to this
      // reader's connection and not to the process.
      const executor = createExecutor(config, {
        registry: createToolRegistry(tools),
        models: deps.models,
        modelFor: deps.modelFor,
        onEvent: (event) => {
          if (event.kind === 'token') {
            onEvent({ kind: 'token', text: event.text })
            return
          }
          const summarise = summaries.get(event.tool)
          onEvent({
            kind: 'tool_call',
            step: event.step,
            tool: event.tool,
            summary: summarise ? summarise(event.output) : 'done',
          })
        },
      })

      const run = await executor.start({
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        startedBy: input.actorId,
        definition: deps.definition,
        input: { text: input.text, sessionId: input.sessionId },
      })

      const outcome = await executor.run(input.workspaceId, run.id)
      if (outcome.status !== 'succeeded') {
        // Carried rather than swallowed: the reader is told why the answer
        // stopped, and the run id goes with it so the trace is reachable.
        throw new TurnFailed(outcome.error ?? 'the turn did not complete', run.id)
      }

      // The answer is read from the run's outcome rather than accumulated from
      // the frames we happened to send. The stream is what a reader saw; the
      // run is what happened, and persisting the former would record something
      // different from the trace the moment a frame is dropped or retried.
      return { runId: run.id, text: typeof outcome.output === 'string' ? outcome.output : '' }
    },
  }
}

/** A turn that ended without an answer, carrying the run it belongs to. */
export class TurnFailed extends Error {
  constructor(
    message: string,
    readonly runId: string,
  ) {
    super(message)
    this.name = 'TurnFailed'
  }
}
