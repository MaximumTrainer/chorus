import { z } from 'zod'
import { normaliseSubject, type AnyTool, type ClarificationQuestion, type Retriever, type WorkflowDefinition } from '@chorus/core'
import type { DbConfig } from '@chorus/db'
import { createClarifyTool, createExecutor, createToolRegistry, type PromptSource } from '@chorus/agent'
import type { ModelProvider, ModelRef } from '@chorus/llm'

/** An answer a session already holds, passed into a turn so it is not re-asked (CHAT-4). */
export interface PriorAnswer {
  readonly subject: string
  readonly question: string
  readonly answer: string
}

/** The tool name the clarify step runs under; the turn surfaces its output as questions. */
const CLARIFY_TOOL = 'clarify'

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
  | { readonly kind: 'context'; readonly bundleId: string; readonly fragments: number }
  /** The turn is asking rather than answering: these are the clarifying questions (CHAT-4). */
  | { readonly kind: 'clarification'; readonly questions: readonly ClarificationQuestion[] }

export interface TurnResult {
  readonly runId: string
  /** The whole answer, for persistence — the stream is not the record. */
  readonly text: string
  /** What grounded it, recorded on the message so the panel is exact (CHAT-3). */
  readonly bundleId?: string
  /**
   * The reader hung up before the turn finished (CHAT-2 AC3).
   *
   * Not an error: an interruption is the system doing as it was told. `text`
   * is then how far the answer got, which is still worth keeping.
   */
  readonly interrupted?: boolean
  /**
   * The turn asked clarifying questions rather than answering (CHAT-4).
   *
   * When present, the turn produced no answer: these are what it needs settled
   * first, and the caller records them as the assistant's message.
   */
  readonly questions?: readonly ClarificationQuestion[]
}

export interface TurnRunner {
  run(
    input: {
      readonly workspaceId: string
      readonly sessionId: string
      readonly teamId: string
      readonly actorId: string
      readonly text: string
      /** Answers the session already holds, so the turn does not re-ask them (CHAT-4). */
      readonly answers?: readonly PriorAnswer[]
      /** Aborts the turn when the reader hangs up (CHAT-2 AC3). */
      readonly signal?: AbortSignal
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
/** Who a turn tool acts as, so it writes as the person and never with more than their rights (CHAT-6 AC5). */
export interface TurnToolContext {
  readonly workspaceId: string
  readonly teamId: string
  readonly actor: { readonly userId: string; readonly role: string }
}

export interface TurnTool {
  readonly name: string
  /** Shown to the model choosing a tool; defaults to the name when absent. */
  readonly description?: string
  readonly summarise: (output: unknown) => string
  readonly execute?: (input: Record<string, unknown>, ctx: TurnToolContext) => Promise<unknown>
}

export function createTurnRunner(
  config: DbConfig,
  deps: {
    readonly models: ModelProvider
    readonly modelFor: (tier: string) => ModelRef
    readonly definition: WorkflowDefinition
    readonly tools?: readonly TurnTool[]
    /** Where a `retrieve` step gets the turn's grounding (CHAT-3, BRAIN-4). */
    readonly retriever?: Retriever
    /** Where a model or clarify step loads its prompt (CHAT-4 needs the clarify template). */
    readonly prompts?: PromptSource
  },
): TurnRunner {
  const summaries = new Map(deps.tools?.map((tool) => [tool.name, tool.summarise]) ?? [])

  const tools: AnyTool[] = (deps.tools ?? []).map(
    (tool) =>
      ({
        name: tool.name,
        description: tool.description ?? tool.name,
        input: z.object({}).passthrough(),
        output: z.unknown(),
        sideEffect: 'none',
        requiredRole: 'member',
        requiredScopes: [],
        // The run's identity reaches the tool, so a tool acting on an artefact
        // does so as the person and with their rights, never elevated (AC5).
        execute: async (input: Record<string, unknown>, ctx: { workspaceId: string; teamId: string; actor: { userId: string; role: string } }) =>
          tool.execute
            ? tool.execute(input, { workspaceId: ctx.workspaceId, teamId: ctx.teamId, actor: ctx.actor })
            : { ok: true },
      }) as unknown as AnyTool,
  )

  return {
    async run(input, onEvent) {
      let bundleId: string | undefined
      // Captured from the clarify tool's output: when the turn asks rather than
      // answers, these are what it needs settled first (CHAT-4).
      let questions: readonly ClarificationQuestion[] | undefined
      // A fresh executor per turn, because the event sink belongs to this
      // reader's connection and not to the process.
      const executor = createExecutor(config, {
        // The clarify tool is always available to a turn: it is how CHAT-4's
        // budget is enforced, and it has no side effect to gate.
        registry: createToolRegistry([createClarifyTool() as unknown as AnyTool, ...tools]),
        models: deps.models,
        modelFor: deps.modelFor,
        ...(deps.retriever ? { retriever: deps.retriever } : {}),
        ...(deps.prompts ? { prompts: deps.prompts } : {}),
        onEvent: (event) => {
          if (event.kind === 'token') {
            onEvent({ kind: 'token', text: event.text })
            return
          }
          if (event.kind === 'context') {
            bundleId = event.bundleId
            onEvent({ kind: 'context', bundleId: event.bundleId, fragments: event.fragments })
            return
          }
          // A tool whose output asks rather than answers — the clarify step, or
          // an artefact tool that found an ambiguous reference (CHAT-6 AC4) —
          // makes the turn a clarification turn. The shape is the contract, not
          // the tool's name, so any tool can defer to the person this way.
          const asking = event.output as { asked?: boolean; questions?: ClarificationQuestion[] }
          if (event.tool === CLARIFY_TOOL || (asking.asked && asking.questions)) {
            if (asking.asked && asking.questions && asking.questions.length > 0) {
              questions = asking.questions
              onEvent({ kind: 'clarification', questions: asking.questions })
            }
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

      const answers = input.answers ?? []
      const run = await executor.start({
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        startedBy: input.actorId,
        definition: deps.definition,
        input: {
          text: input.text,
          sessionId: input.sessionId,
          // Snake-cased alias so a tool step can reference it: a template
          // reference must be lower_snake (`{{input.session_id}}`).
          session_id: input.sessionId,
          // For the clarify prompt: the settled answers, as readable text.
          answers: answers.length > 0 ? answers.map((a) => `${a.subject}: ${a.answer}`).join('\n') : '(none yet)',
          // For the clarify tool: the subjects to suppress, as a list. Snake-cased
          // because a template reference must be lower_snake (`{{input.known_subjects}}`).
          known_subjects: answers.map((a) => normaliseSubject(a.subject)),
        },
      })

      const outcome = await executor.run(input.workspaceId, run.id, {
        ...(input.signal ? { signal: input.signal } : {}),
      })

      // Interruption is not failure. The reader asked for it, the run reached a
      // terminal state, and how far the answer got is worth keeping — so it is
      // returned rather than thrown (CHAT-2 AC3).
      if (outcome.status === 'stopped' && input.signal?.aborted) {
        return {
          runId: run.id,
          text: typeof outcome.output === 'string' ? outcome.output : '',
          interrupted: true,
          ...(bundleId ? { bundleId } : {}),
        }
      }

      if (outcome.status !== 'succeeded') {
        // Carried rather than swallowed: the reader is told why the answer
        // stopped, and the run id goes with it so the trace is reachable.
        throw new TurnFailed(outcome.error ?? 'the turn did not complete', run.id)
      }

      // The answer is read from the run's outcome rather than accumulated from
      // the frames we happened to send. The stream is what a reader saw; the
      // run is what happened, and persisting the former would record something
      // different from the trace the moment a frame is dropped or retried.
      return {
        runId: run.id,
        // A clarification turn produced no answer; its content is the questions.
        text: questions ? '' : typeof outcome.output === 'string' ? outcome.output : '',
        ...(bundleId ? { bundleId } : {}),
        ...(questions ? { questions } : {}),
      }
    },
  }
}

/**
 * A turn that ended without an answer, carrying the run it belongs to.
 *
 * The field is declared and assigned rather than written as a constructor
 * parameter property. Parameter properties need a transform, not just type
 * stripping, and the browser journeys run under Node's strip-only mode — where
 * one is a `SyntaxError` at import, before a single test runs. `pnpm verify`
 * does not run those journeys, so CI was the first thing that could notice.
 */
export class TurnFailed extends Error {
  readonly runId: string

  constructor(message: string, runId: string) {
    super(message)
    this.name = 'TurnFailed'
    this.runId = runId
  }
}
