import { z } from 'zod'
import type { ModelProvider, ModelRef, ToolSpec } from '@chorus/llm'
import {
  BRIEF_FILENAME,
  BRIEF_JSON_FILENAME,
  type CodingAdapter,
  type JobContext,
  type JobEvent,
  type JobResult,
  type PreparedJob,
} from '../adapter.js'
import type { Sandbox, SandboxChange } from '@chorus/core'

/**
 * The reference coding adapter (CODE-3 AC2).
 *
 * > The **reference adapter** is a small tool-using loop (read, search, edit,
 * > run) built on the provider router, so the platform works with any model —
 * > including a local one — with no third-party CLI installed.
 *
 * It is the adapter that matters most, and not because it is the best one. It
 * is the proof that the platform's most valuable feature is not hostage to one
 * vendor's pricing, availability or terms: a deployment with a local model
 * endpoint and nothing else installed can still turn a task into a diff.
 *
 * Built first, deliberately (`plan.md` WP-2.3). A vendor CLI brings its own
 * file access, its own network assumptions and its own credential handling, and
 * would paper over gaps in the sandbox contract that this cannot.
 */

export interface ReferenceAdapterOptions {
  readonly models: ModelProvider
  /** Resolved by the router from a purpose; never a model name here. */
  readonly model: ModelRef
  readonly image?: string
  /** How many tool-calling turns before the loop gives up. */
  readonly maxTurns?: number
  /**
   * The output ceiling for each turn.
   *
   * A coding loop makes many calls, and one large ceiling per turn is both
   * wasteful and, on a quota-limited gateway, fatal: the ceiling is checked
   * against the remaining balance before a single token is produced. A live run
   * refused with "you requested up to 8192 tokens, but can only afford 7150".
   */
  readonly maxOutputTokens?: number
}

/**
 * The ceiling on turns.
 *
 * A loop that never gives up is a wall-clock limit waiting to be hit, and being
 * killed by the sandbox tells a reader nothing about what the agent was doing.
 * Stopping on its own terms leaves a summary.
 */
const DEFAULT_MAX_TURNS = 24

/**
 * The per-turn output ceiling when a caller names none.
 *
 * A turn is a decision plus at most a file's worth of edit, not a document.
 * Generous enough for a whole small file, small enough that twenty-four of them
 * is a predictable bill rather than an open one.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096

const TOOLS: readonly ToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a file from the repository. Prefer this over guessing at contents.',
    inputSchema: z.object({ path: z.string() }),
  },
  {
    name: 'search',
    description: 'Search the repository for a string, returning matching paths and lines.',
    inputSchema: z.object({ query: z.string() }),
  },
  {
    name: 'edit_file',
    description:
      'Replace a file entirely with new contents. Paths outside the allow-list are refused.',
    inputSchema: z.object({ path: z.string(), contents: z.string() }),
  },
  {
    name: 'run',
    description: 'Run a shell command in the repository, such as the test or lint command.',
    inputSchema: z.object({ command: z.string() }),
  },
]

/**
 * The loop's standing instructions.
 *
 * The test-command clause is conditional, and it is conditional because a live
 * run showed what the unconditional version costs. Told to "run the repository
 * test command" by a brief whose conventions section said none was detected,
 * the agent finished the actual edit and then spent four of its eight turns
 * hunting for a `package.json` that did not exist — burning the budget on an
 * instruction that contradicted the brief it had been given.
 *
 * The brief is the authority on the repository. Anything here that restates
 * what the brief already says is a second source of truth, and the model
 * follows whichever it read last.
 */
const SYSTEM = [
  'You are a coding agent working inside a sandbox on one task.',
  'Read BRIEF.md first: it carries the task, its acceptance criteria, the team charter,',
  'the repository conventions and the code pointers you should start from.',
  'Satisfy the acceptance criteria and nothing else.',
  'If the brief names a test command, run it before you finish; if it says none was',
  'detected, do not go looking for one — there is not one.',
  'Stop as soon as the criteria are met: say what you changed and why, in prose,',
  'and make no further tool calls.',
].join(' ')

export function createReferenceAdapter(options: ReferenceAdapterOptions): CodingAdapter {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS

  return {
    id: 'reference',
    image: options.image ?? 'ghcr.io/chorus/adapter-reference:1',
    // None. The model is reached through the router, which the runner configures
    // — so this adapter works against a local endpoint with no credential at
    // all, which is the whole of AC2.
    requiredSecrets: [],

    async prepare(context: JobContext): Promise<PreparedJob> {
      return {
        files: {
          // The brief exactly as the one builder produced it. An adapter that
          // reworded it here would be a second brief builder, and CODE-2 AC2
          // rests on there being one.
          [BRIEF_FILENAME]: context.brief.markdown,
          [BRIEF_JSON_FILENAME]: JSON.stringify(context.brief.json, null, 2),
        },
        // This adapter runs in-process against the router rather than shelling
        // out, so the entrypoint is nominal — but it is still declared, because
        // the contract is that every adapter has one and a runner should not
        // special-case this adapter to know that.
        command: ['chorus-reference-agent', '--brief', BRIEF_FILENAME, '--non-interactive'],
      }
    },

    async *run(prepared: PreparedJob, sandbox: Sandbox): AsyncIterable<JobEvent> {
      for (const [path, content] of Object.entries(prepared.files)) {
        await sandbox.write(path, content)
      }
      yield { kind: 'step', text: 'Brief written; starting.' }

      const brief = prepared.files[BRIEF_FILENAME] ?? ''
      const transcript: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: brief },
      ]

      let summary = ''

      for (let turn = 0; turn < maxTurns; turn += 1) {
        const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []
        let text = ''

        for await (const event of options.models.stream({
          model: options.model,
          messages: transcript,
          context: {
            workspaceId: sandbox.jobId,
            teamId: '',
            purpose: 'code',
          },
          tools: TOOLS,
          maxOutputTokens,
        })) {
          if (event.type === 'token') {
            text += event.text
            continue
          }
          if (event.type === 'tool_call_end') {
            calls.push({ id: event.id, name: event.name, arguments: event.arguments })
            continue
          }
          if (event.type === 'error') {
            // Reported, not swallowed (AC5). A model failure mid-job is the
            // single most likely way this adapter fails, and a loop that
            // continued past it would produce a confident empty diff.
            yield { kind: 'failed', message: `the model call failed: ${event.message}` }
            return
          }
        }

        if (text.trim() !== '') summary = text.trim()

        if (calls.length === 0) {
          yield { kind: 'output', text: summary }
          yield { kind: 'finished' }
          return
        }

        transcript.push({ role: 'assistant', content: text })

        for (const call of calls) {
          const outcome = await runTool(call, sandbox)
          if (outcome.timedOut) {
            yield {
              kind: 'failed',
              message: `the job timed out after ${outcome.limitMs}ms while running ${call.name}`,
            }
            return
          }
          yield { kind: 'tool', tool: call.name, summary: outcome.summary }
          transcript.push({ role: 'user', content: `${call.name} result:\n${outcome.result}` })
        }
      }

      // Out of turns rather than out of time. Stated as a failure, because a
      // job that stopped thinking half way through has not done the work and a
      // caller must not treat its diff as finished.
      yield {
        kind: 'failed',
        message: `the agent did not finish within ${maxTurns} turns`,
      }
    },

    async collect(sandbox: Sandbox): Promise<JobResult> {
      const [diff, change] = await Promise.all([sandbox.diff(), sandbox.change()])

      let testOutput = ''
      let failure: string | undefined
      for await (const event of sandbox.exec(['pnpm', 'run', 'test'])) {
        if (event.type === 'stdout' || event.type === 'stderr') testOutput += event.text
        if (event.type === 'exit' && event.code !== 0) {
          failure = `the repository's test command exited ${event.code}`
        }
        if (event.type === 'timeout') {
          failure = `the repository's test command timed out after ${event.limitMs}ms`
        }
      }

      if (change.changedPaths.length === 0 && failure === undefined) {
        failure = 'the agent produced no change'
      }

      return {
        diff,
        summary: summaryOf(change),
        testOutput,
        change,
        ...(failure ? { failure } : {}),
      }
    },
  }
}

function summaryOf(change: SandboxChange): string {
  if (change.changedPaths.length === 0) return 'No files changed.'
  return `Changed ${change.changedPaths.length} file(s): ${change.changedPaths.join(', ')} (+${change.addedLines}/-${change.removedLines}).`
}

/**
 * Runs one tool call against the sandbox.
 *
 * Every path the model names is checked against the sandbox's allow-list before
 * anything is written, and refused *to the model* rather than thrown: a refusal
 * it can read is a correction it can act on, where an exception ends the job
 * over a mistake it would have fixed if told (AC6).
 */
async function runTool(
  call: { name: string; arguments: Record<string, unknown> },
  sandbox: Sandbox,
): Promise<{ result: string; summary: string; timedOut?: boolean; limitMs?: number }> {
  if (call.name === 'read_file') {
    const path = String(call.arguments.path ?? '')
    try {
      const contents = await sandbox.read(path)
      return { result: contents, summary: `read ${path}` }
    } catch (error) {
      return {
        result: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
        summary: `could not read ${path}`,
      }
    }
  }

  if (call.name === 'edit_file') {
    const path = String(call.arguments.path ?? '')
    const contents = String(call.arguments.contents ?? '')
    await sandbox.write(path, contents)
    return { result: `wrote ${path}`, summary: `edited ${path}` }
  }

  if (call.name === 'search' || call.name === 'run') {
    const command =
      call.name === 'search'
        ? ['grep', '-rn', String(call.arguments.query ?? '')]
        : String(call.arguments.command ?? '').split(/\s+/).filter(Boolean)

    let output = ''
    for await (const event of sandbox.exec(command)) {
      if (event.type === 'stdout' || event.type === 'stderr') output += event.text
      if (event.type === 'timeout') {
        return { result: output, summary: 'timed out', timedOut: true, limitMs: event.limitMs }
      }
    }
    return { result: output, summary: `${call.name}: ${command.join(' ').slice(0, 60)}` }
  }

  return { result: `unknown tool "${call.name}"`, summary: `unknown tool ${call.name}` }
}
