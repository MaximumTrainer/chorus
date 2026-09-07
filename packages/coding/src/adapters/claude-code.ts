import type { Sandbox, SandboxChange } from '@chorus/core'
import {
  BRIEF_FILENAME,
  BRIEF_JSON_FILENAME,
  type CodingAdapter,
  type JobContext,
  type JobEvent,
  type JobResult,
  type PreparedJob,
} from '../adapter.js'

/**
 * The `claude-code` adapter (CODE-3, architecture.md §12.2).
 *
 * The Claude Agent SDK is a different product from the Anthropic API SDK that
 * `packages/llm` uses. That one is a client for the Messages API; this is the
 * Claude Code harness packaged as a library, bringing its own agent loop, its
 * own file and shell tools, and its own context management. Which is why this
 * adapter is thin: the harness is the thing being adapted, and reimplementing
 * any of it here would be work the reference adapter already does differently
 * and on purpose.
 *
 * **The SDK never enters Chorus's source.** It is installed in the adapter's
 * sandbox image and invoked as the container entrypoint, so the `@anthropic-ai/*`
 * boundary rule is never engaged — the dependency lives in `deploy/images`, not
 * in `apps` or `packages`. Worth saying plainly, because "add the Claude Code
 * SDK" reads like a boundary violation and is not one.
 */

export interface ClaudeCodeAdapterOptions {
  readonly image?: string
  /** Overrides the effort the harness runs at, where a deployment tunes it. */
  readonly effort?: 'low' | 'medium' | 'high'
}

/**
 * The one secret it needs.
 *
 * Declared rather than taken, so the sandbox environment is built as an
 * allow-list and can be enumerated (CODE-4 AC1). `api.anthropic.com` must also
 * be on the job's egress allow-list, which is the runner's business and is
 * asserted against a real container (#169).
 */
const REQUIRED_SECRETS = ['ANTHROPIC_API_KEY'] as const

export function createClaudeCodeAdapter(
  options: ClaudeCodeAdapterOptions = {},
): CodingAdapter {
  return {
    id: 'claude-code',
    image: options.image ?? 'ghcr.io/chorus/adapter-claude-code:1',
    requiredSecrets: [...REQUIRED_SECRETS],

    async prepare(context: JobContext): Promise<PreparedJob> {
      return {
        files: {
          // The brief, byte for byte from the one builder. An adapter that
          // reworded it would be a second brief builder wearing another name,
          // and CODE-2 AC2 rests on there being one.
          [BRIEF_FILENAME]: context.brief.markdown,
          [BRIEF_JSON_FILENAME]: JSON.stringify(context.brief.json, null, 2),
        },
        // Non-interactive by construction (AC3). `--print` runs the harness
        // headlessly and exits; the permission mode is what stops it stopping
        // to ask, which in a container with no terminal is a hang that lasts
        // until the wall-clock limit and reports nothing.
        command: [
          'claude',
          '--print',
          '--permission-mode',
          'acceptEdits',
          '--add-dir',
          '.',
          ...(options.effort ? ['--effort', options.effort] : []),
          `Read ${BRIEF_FILENAME} and implement the task it describes.`,
        ],
      }
    },

    async *run(prepared: PreparedJob, sandbox: Sandbox): AsyncIterable<JobEvent> {
      for (const [path, content] of Object.entries(prepared.files)) {
        await sandbox.write(path, content)
      }
      yield { kind: 'step', text: 'Brief written; starting Claude Code.' }

      let sawOutput = false

      for await (const event of sandbox.exec(prepared.command)) {
        if (event.type === 'stdout' || event.type === 'stderr') {
          sawOutput = true
          yield { kind: 'output', text: event.text }
          continue
        }

        if (event.type === 'timeout') {
          // Explained, not merely killed. A job terminated silently is
          // indistinguishable from one that finished having done nothing.
          yield {
            kind: 'failed',
            message: `the job timed out after ${event.limitMs}ms and was terminated`,
          }
          return
        }

        if (event.type === 'exit') {
          if (event.code !== 0) {
            yield {
              kind: 'failed',
              message: `claude-code exited ${event.code}${sawOutput ? '' : ' without producing any output'}`,
            }
            return
          }
          yield { kind: 'finished' }
          return
        }
      }

      // The stream ended without an exit code, which means the runtime lost the
      // process. Reported rather than treated as success: a job whose outcome
      // is unknown must not become a pull request.
      yield { kind: 'failed', message: 'claude-code ended without reporting an exit code' }
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
        failure = 'claude-code produced no change'
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
