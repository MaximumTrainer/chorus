import {
  buildSandboxEnvironment,
  type Sandbox,
  type SandboxChange,
  type SandboxOutput,
  type SandboxRunner,
  type SandboxSpec,
} from '@chorus/core'

/**
 * A scriptable sandbox (CLAUDE.md §4, CODE-4).
 *
 * > `FakeSandbox` — implements the `Sandbox` contract, applies a scripted diff
 * > and emits scripted job events with no container.
 *
 * It exists so an adapter can be tested against the contract without a
 * container, and it is honest about what that can and cannot prove. It applies
 * the same environment construction the real runner does, so an adapter that
 * expects a variable the runner would not provide fails here rather than in
 * production. It does **not** pretend to enforce isolation: a test asserting
 * that egress was refused against this fake would be asserting that the fake
 * refuses egress, which is a fact about the fake.
 *
 * Shipped in `packages/testing` and maintained like production code, because
 * every adapter's contract test rests on its fidelity.
 */

export interface FakeSandboxScript {
  /** Paths the job changed, and the size of the change. */
  readonly change?: SandboxChange
  /** The unified diff `diff()` returns. */
  readonly diff?: string
  /** Output per command, keyed by the command's first word. */
  readonly output?: Readonly<Record<string, readonly SandboxOutput[]>>
  /** Every command hangs, so a timeout path can be exercised. */
  readonly hang?: boolean
  /** `exec` throws, standing in for a runtime that could not start a process. */
  readonly failWith?: string
}

export interface FakeSandbox extends Sandbox {
  script(next: FakeSandboxScript): void
  /** Commands the adapter ran, in order — what it did, not what it returned. */
  commands(): readonly (readonly string[])[]
  /** Files the adapter wrote, by path. The brief is the one that matters. */
  files(): Readonly<Record<string, string>>
  /** Whether `destroy` was called. A leaked container is a real defect. */
  destroyed(): boolean
}

const EMPTY_CHANGE: SandboxChange = { changedPaths: [], addedLines: 0, removedLines: 0 }

export function createFakeSandbox(
  spec: SandboxSpec,
  initial: FakeSandboxScript = {},
): FakeSandbox {
  let current: FakeSandboxScript = initial
  const ran: (readonly string[])[] = []
  const written: Record<string, string> = {}
  let wasDestroyed = false

  // The same construction the real runner uses, so an adapter that relies on a
  // variable the runner would never provide fails in a test rather than in a
  // container nobody is watching.
  const environment = buildSandboxEnvironment(spec)

  return {
    jobId: spec.jobId,

    script(next) {
      current = next
    },

    commands() {
      return ran
    },

    files() {
      return written
    },

    destroyed() {
      return wasDestroyed
    },

    async write(path, content) {
      written[path] = content
    },

    async read(path) {
      const content = written[path]
      if (content === undefined) throw new Error(`no such file in the sandbox: ${path}`)
      return content
    },

    async *exec(command: readonly string[]): AsyncIterable<SandboxOutput> {
      ran.push(command)

      if (current.failWith) throw new Error(current.failWith)

      if (current.hang) {
        // Ends only when the wall-clock limit would have. A test for the
        // timeout path should not have to wait for real time to pass.
        yield { type: 'timeout', limitMs: spec.limits.wallClockMs }
        return
      }

      const scripted = current.output?.[command[0] ?? '']
      if (scripted) {
        for (const event of scripted) yield event
        return
      }

      yield { type: 'exit', code: 0 }
    },

    async diff() {
      return current.diff ?? ''
    },

    async change() {
      return current.change ?? EMPTY_CHANGE
    },

    async environment() {
      return environment
    },

    async destroy() {
      wasDestroyed = true
    },
  }
}

/**
 * A runner that hands out fake sandboxes.
 *
 * Keeps every sandbox it provisioned, so a test can assert that each was
 * destroyed — a leaked container is one of the defects CODE-4 AC7 exists to
 * prevent, and it is invisible from inside the job that leaked it.
 */
export function createFakeSandboxRunner(
  script: FakeSandboxScript = {},
): SandboxRunner & { provisioned(): readonly FakeSandbox[] } {
  const sandboxes: FakeSandbox[] = []

  return {
    async provision(spec) {
      const sandbox = createFakeSandbox(spec, script)
      sandboxes.push(sandbox)
      return sandbox
    },

    async reconcile() {
      const leaked = sandboxes.filter((sandbox) => !sandbox.destroyed())
      for (const sandbox of leaked) await sandbox.destroy()
      return { removed: leaked.map((sandbox) => sandbox.jobId) }
    },

    provisioned() {
      return sandboxes
    },
  }
}
