import { ConfigurationError } from './errors.js'

/**
 * The sandbox contract (CODE-4, architecture.md §12.3).
 *
 * Declared in `core` for the same reason `ArtefactWriter` is: a feature package
 * may only reach another through a core interface (CLAUDE.md §10). The coding
 * package implements against this and `packages/testing` fakes it, and if the
 * contract lived in either of them the two would depend on each other.
 *
 * §12.3 lists its properties as non-negotiable and backed by a security suite,
 * and ADR-0014 makes the runtime deployment configuration — rootless Podman by
 * default, gVisor where workspaces share hardware. This interface is the only
 * thing the platform codes against; which runtime satisfies it is not the
 * platform's business.
 *
 * The file is deliberately split between what is *logic* and what is *kernel*.
 * Environment construction and result validation are pure functions here,
 * asserted by `test/nfr/sandbox-security.test.ts` on every pull request.
 * Egress refusal, resource limits and orphan reconciliation are properties of a
 * real runtime, and a mock asserting them would be a test that a comment is
 * still present.
 */

export interface SandboxLimits {
  readonly cpus: number
  readonly memoryMb: number
  readonly diskMb: number
  readonly processes: number
  readonly wallClockMs: number
}

export interface SandboxRepository {
  readonly fullName: string
  /**
   * Carries the short-lived, repository-scoped token (INT-2 AC2).
   *
   * Used to clone and then discarded. It never reaches the environment: an
   * environment is readable by every process in the container, including
   * whatever the model decided to run.
   */
  readonly cloneUrl: string
  readonly baseBranch: string
  /** `chorus/<task-key>-<slug>` (CODE-5). */
  readonly branch: string
}

export interface SandboxSpec {
  readonly jobId: string
  readonly image: string
  readonly repository: SandboxRepository
  /** Reachable from inside the sandbox, and scoped by `jobToken`. */
  readonly apiUrl: string
  /**
   * A token that can post job events and read its own brief, and nothing else
   * (AC3). Not a workspace credential with a short life — a different token
   * with a smaller surface.
   */
  readonly jobToken: string
  /** Exactly the secrets the adapter declared in `requiredSecrets` (§12.2). */
  readonly secrets: Readonly<Record<string, string>>
  readonly limits: SandboxLimits
  /** Hosts the sandbox may reach. Everything else is refused by the runtime. */
  readonly egressAllowList: readonly string[]
  /** Globs the job may change. */
  readonly pathAllowList: readonly string[]
  /** Globs it may not change even when the allow-list would permit them. */
  readonly protectedPaths: readonly string[]
  /** Lines changed, beyond which the result is refused. */
  readonly maxChangedLines?: number
}

/** One line of output from a command run inside the sandbox. */
export type SandboxOutput =
  | { readonly type: 'stdout'; readonly text: string }
  | { readonly type: 'stderr'; readonly text: string }
  | { readonly type: 'exit'; readonly code: number }
  /** The wall-clock limit was reached and the process was killed (AC5). */
  | { readonly type: 'timeout'; readonly limitMs: number }

export interface SandboxChange {
  readonly changedPaths: readonly string[]
  readonly addedLines: number
  readonly removedLines: number
}

/**
 * A provisioned sandbox, as an adapter sees it.
 *
 * Deliberately narrow. An adapter gets to put files in, run commands, and read
 * the diff out; it does not get to configure the network, raise its own limits
 * or reach the host. Everything an adapter cannot ask for is something a
 * compromised adapter cannot ask for.
 */
export interface Sandbox {
  readonly jobId: string
  /** Writes a file into the working tree — the brief, an agent config file. */
  write(path: string, content: string): Promise<void>
  read(path: string): Promise<string>
  /** Runs a command, streaming its output, and enforces the wall-clock limit. */
  exec(command: readonly string[]): AsyncIterable<SandboxOutput>
  /** The unified diff the job produced against its base. */
  diff(): Promise<string>
  /** What changed, for validation before a pull request is opened (AC6). */
  change(): Promise<SandboxChange>
  /** The environment the container actually has, so a test can enumerate it. */
  environment(): Promise<Readonly<Record<string, string>>>
  /** Destroys the container, its volume and its network (AC7). */
  destroy(): Promise<void>
}

export interface SandboxRunner {
  provision(spec: SandboxSpec): Promise<Sandbox>
  /**
   * Destroys anything left behind by a crash or a restart (AC7).
   *
   * Returns what it removed, so "the runner cleaned up" is an observation
   * rather than an assumption.
   */
  reconcile(): Promise<{ readonly removed: readonly string[] }>
}

/**
 * The environment a sandbox gets (AC1).
 *
 * Built **only from the spec**. Not the host environment minus the ones we
 * thought of, and not the host environment at all: a subtractive version is
 * correct until somebody adds a variable, and then it is silently wrong in the
 * direction that leaks.
 *
 * Nothing is carried from the host, including `PATH` and `HOME`. An earlier
 * version carried those two, reasoning that a container without them cannot run
 * anything — which is false. The image sets its own, from its Dockerfile, and
 * the host's are at best irrelevant. A real container found this the hard way:
 * on a Windows host the inherited `PATH` was a semicolon-separated Windows path
 * that meant nothing to a Linux container and broke the run outright. The
 * environment being derived from the spec alone is both more correct and
 * strictly smaller, which is the direction a security control should move.
 */
export function buildSandboxEnvironment(spec: SandboxSpec): Record<string, string> {
  // A deployment that configured no egress policy must not silently get none.
  // Refusing here rather than at the runtime means the mistake is found when
  // the job is prepared, not after the container has already reached the
  // internet (AC2).
  if (spec.egressAllowList.length === 0) {
    throw new ConfigurationError(
      `Job "${spec.jobId}" has an empty egress allow-list. A sandbox with no ` +
        `allow-list would be unrestricted; configure the git host, the model ` +
        `endpoint and any package registries the job needs.`,
      { jobId: spec.jobId },
    )
  }

  const env: Record<string, string> = {
    CHORUS_JOB_ID: spec.jobId,
    CHORUS_API_URL: spec.apiUrl,
    CHORUS_JOB_TOKEN: spec.jobToken,
  }

  // Exactly what the adapter declared. A second adapter's key here would be a
  // credential leak between adapters sharing a host.
  for (const [name, value] of Object.entries(spec.secrets)) {
    env[name] = value
  }

  return env
}

/** Compiles a glob to a regular expression anchored at both ends. */
function globToRegExp(glob: string): RegExp {
  let pattern = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!
    if (char === '*') {
      if (glob[index + 1] === '*') {
        // `**` crosses directory separators; `*` does not.
        pattern += '.*'
        index += 1
        if (glob[index + 1] === '/') index += 1
      } else {
        pattern += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      pattern += '[^/]'
      continue
    }
    pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${pattern}$`)
}

function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path))
}

export interface SandboxVerdict {
  readonly allowed: boolean
  /** Every violation, named. A reader has to decide what to do about each. */
  readonly violations: readonly string[]
}

/** The default ceiling on a single job's diff, in changed lines. */
export const DEFAULT_MAX_CHANGED_LINES = 5_000

/**
 * Decides whether a result may become a pull request (AC6).
 *
 * Runs **before** the push, not after it. §11.7's ordering argument applies
 * here for the same reason it applies to artefacts: a branch that has already
 * been pushed has been seen, and a pull request that has already been opened
 * has been reviewed by somebody who assumed it passed a check it did not.
 *
 * Every violation is collected rather than the first one thrown, because a job
 * that fails validation three times in a row — once per violation discovered —
 * costs three sandbox runs to learn what one run could have said.
 */
export function validateSandboxResult(
  change: SandboxChange,
  spec: SandboxSpec,
): SandboxVerdict {
  const violations: string[] = []

  if (change.changedPaths.length === 0) {
    // Refused rather than treated as success. An empty pull request tells a
    // reviewer nothing and costs them the time to work out that it is empty.
    violations.push('the job produced no change, so there is nothing to open a pull request for')
  }

  const limit = spec.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES
  const total = change.addedLines + change.removedLines
  if (total > limit) {
    violations.push(
      `the diff changes ${total} lines, over the size limit of ${limit}`,
    )
  }

  for (const path of change.changedPaths) {
    // Protected paths are checked first and independently of the allow-list. A
    // protected path that could be unlocked by widening the ordinary allow-list
    // would not be protected.
    if (matchesAny(path, spec.protectedPaths)) {
      violations.push(`${path} is a protected path and may not be changed by a job`)
      continue
    }
    if (!matchesAny(path, spec.pathAllowList)) {
      violations.push(`${path} is outside the repository's path allow-list`)
    }
  }

  return { allowed: violations.length === 0, violations }
}
