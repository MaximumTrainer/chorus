import { describe, it, expect } from 'vitest'

import { assembleBrief, type Brief } from '../brief.js'
import { BRIEF_FILENAME, type CodingAdapter, type JobEvent } from '../adapter.js'
import { validateSandboxResult, type Sandbox, type SandboxSpec } from '@chorus/core'

/**
 * The coding-adapter contract kit (CODE-3 AC1).
 *
 * > **Given** each adapter · **When** the shared contract-test kit runs against
 * > a fake sandbox · **Then** all pass identically.
 *
 * "Identically" is the word that matters. A kit with a per-adapter exemption is
 * not a contract, it is a description of whichever adapter was written first —
 * and the guarantee an adapter-pluggable platform makes is precisely that
 * swapping one for another does not change what a job means.
 *
 * The kit asserts behaviour a job's *caller* depends on: that the brief was
 * placed where the agent will read it, that a hang ends, that a failure is
 * reported rather than swallowed, and that a result which violates the
 * repository's rules never becomes a pull request. It does not assert how an
 * adapter thinks.
 */

export const CONTRACT_SPEC: SandboxSpec = {
  jobId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  image: 'ghcr.io/chorus/adapter-under-test:1',
  repository: {
    fullName: 'acme/billing',
    cloneUrl: 'https://x-access-token:ghs_scoped@github.com/acme/billing.git',
    baseBranch: 'main',
    branch: 'chorus/CH-1-split-the-invoice-parser',
  },
  apiUrl: 'https://chorus.internal/api',
  jobToken: 'job_scoped_token',
  secrets: {},
  limits: { cpus: 2, memoryMb: 4096, diskMb: 8192, processes: 256, wallClockMs: 60_000 },
  egressAllowList: ['github.com', 'api.anthropic.com'],
  pathAllowList: ['src/**', 'test/**'],
  protectedPaths: ['.github/workflows/**'],
}

export function contractBrief(): Brief {
  return assembleBrief({
    charter: 'We ship small changes and we write the test first.',
    repositoryFullName: 'acme/billing',
    baseBranch: 'main',
    conventions: {
      packageManager: 'pnpm',
      testCommand: 'pnpm run test',
      lintCommand: 'pnpm run lint',
      formatCommand: null,
      buildCommand: null,
      contributionGuide: null,
      agentInstructions: [],
      monorepo: null,
    },
    documents: [],
    decisions: [],
    captures: [],
    task: {
      key: 'CH-1',
      title: 'Split the invoice parser',
      description: 'parseInvoice does three jobs.',
      acceptanceCriteria: ['Parsing is separated from validation'],
      tags: [],
    },
    pointers: [
      {
        path: 'src/billing/parse.ts',
        symbolName: 'parseInvoice',
        lineStart: 1,
        lineEnd: 40,
        commitSha: 'commit-1',
        source: 'generated',
        stale: false,
      },
    ],
  })
}

export interface AdapterHarness {
  /** The adapter, rigged to do useful work against a scripted sandbox. */
  working(): { adapter: CodingAdapter; sandbox: Sandbox }
  /** The adapter, where the agent never finishes (AC3). */
  hanging(): { adapter: CodingAdapter; sandbox: Sandbox }
  /** The adapter, where the agent crashes or exits non-zero (AC5). */
  failing(): { adapter: CodingAdapter; sandbox: Sandbox }
  /** The adapter, where the agent edits a path it may not (AC6). */
  outOfBounds(): { adapter: CodingAdapter; sandbox: Sandbox }
}

async function drain(events: AsyncIterable<JobEvent>): Promise<JobEvent[]> {
  const collected: JobEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

export function describeCodingAdapterContract(name: string, harness: AdapterHarness): void {
  describe(`CODE-3 coding adapter contract: ${name}`, () => {
    it('CODE-3 AC1: it declares an id, an image and exactly the secrets it needs', () => {
      const { adapter } = harness.working()

      expect(adapter.id).toBeTruthy()
      expect(adapter.image).toBeTruthy()
      // An array, possibly empty. `undefined` would make the sandbox's
      // allow-list construction fall back to "whatever was around" (CODE-4 AC1).
      expect(Array.isArray(adapter.requiredSecrets)).toBe(true)
    })

    it('CODE-3 AC1: prepare writes the brief where the agent will read it', async () => {
      const { adapter, sandbox } = harness.working()
      const prepared = await adapter.prepare({
        jobId: CONTRACT_SPEC.jobId,
        brief: contractBrief(),
        spec: CONTRACT_SPEC,
      })

      // The brief, from the one builder, unmodified. An adapter that rewrote it
      // would be a second brief builder wearing a different name, and the whole
      // of CODE-2 AC2 rests on there being one.
      expect(Object.keys(prepared.files)).toContain(BRIEF_FILENAME)
      expect(prepared.files[BRIEF_FILENAME]).toBe(contractBrief().markdown)
      expect(prepared.command.length).toBeGreaterThan(0)

      // And it actually reaches the sandbox, rather than being described in a
      // structure nobody applies.
      for (const [path, content] of Object.entries(prepared.files)) {
        await sandbox.write(path, content)
      }
      expect(await sandbox.read(BRIEF_FILENAME)).toContain('Split the invoice parser')
    })

    it('CODE-3 AC3: the entrypoint is non-interactive', async () => {
      const { adapter } = harness.working()
      const prepared = await adapter.prepare({
        jobId: CONTRACT_SPEC.jobId,
        brief: contractBrief(),
        spec: CONTRACT_SPEC,
      })

      // A flag that would wait for a terminal is the failure this catches, and
      // it is invisible until a job hangs for its whole wall-clock limit and
      // reports nothing.
      const command = prepared.command.join(' ')
      expect(command).not.toMatch(/\s-i\b|--interactive\b/)
    })

    it('CODE-3 AC1: run streams events and ends', async () => {
      const { adapter, sandbox } = harness.working()
      const prepared = await adapter.prepare({
        jobId: CONTRACT_SPEC.jobId,
        brief: contractBrief(),
        spec: CONTRACT_SPEC,
      })

      const events = await drain(adapter.run(prepared, sandbox))

      expect(events.length).toBeGreaterThan(0)
      expect(events.at(-1)?.kind).toBe('finished')
    })

    it('CODE-3 AC3: a hang is terminated by the timeout, with a diagnostic', async () => {
      const { adapter, sandbox } = harness.hanging()
      const prepared = await adapter.prepare({
        jobId: CONTRACT_SPEC.jobId,
        brief: contractBrief(),
        spec: CONTRACT_SPEC,
      })

      const events = await drain(adapter.run(prepared, sandbox))
      const failed = events.filter((event) => event.kind === 'failed')

      // Terminated *and* explained. A job that is killed silently is
      // indistinguishable from one that finished having done nothing.
      expect(failed).toHaveLength(1)
      expect((failed[0] as { message: string }).message).toMatch(/timed out|timeout/i)
    })

    it('CODE-3 AC5: a crash is reported, not swallowed', async () => {
      const { adapter, sandbox } = harness.failing()
      const prepared = await adapter.prepare({
        jobId: CONTRACT_SPEC.jobId,
        brief: contractBrief(),
        spec: CONTRACT_SPEC,
      })

      const events = await drain(adapter.run(prepared, sandbox))
      expect(events.some((event) => event.kind === 'failed')).toBe(true)

      // And it survives into the result, so a caller that only reads `collect`
      // does not see an empty success.
      const result = await adapter.collect(sandbox)
      expect(result.failure ?? '').not.toBe('')
    })

    it('CODE-3 AC1: collect returns the diff, a summary and the test output', async () => {
      const { adapter, sandbox } = harness.working()
      const result = await adapter.collect(sandbox)

      expect(typeof result.diff).toBe('string')
      expect(result.summary.length).toBeGreaterThan(0)
      expect(typeof result.testOutput).toBe('string')
      expect(result.change.changedPaths.length).toBeGreaterThan(0)
    })

    it('CODE-3 AC6: a result touching a forbidden path never becomes a pull request', async () => {
      const { adapter, sandbox } = harness.outOfBounds()
      const result = await adapter.collect(sandbox)

      // Validation is the sandbox's rule, not the adapter's opinion: an adapter
      // is exactly the thing that might be compromised, so the check is applied
      // to whatever it returns rather than trusted to it (CODE-4 AC6).
      const verdict = validateSandboxResult(result.change, CONTRACT_SPEC)
      expect(verdict.allowed).toBe(false)
      expect(verdict.violations.join(' ')).toMatch(/allow-list|protected/i)
    })

    it('CODE-3 AC4: the sandbox it runs in carries no platform credential', async () => {
      const { adapter, sandbox } = harness.working()
      const env = await sandbox.environment()

      // Enumerated rather than spot-checked: the failure is a variable that
      // arrived, not one that is missing. The environment is the sandbox's to
      // build (CODE-4 AC1) and the adapter's only say in it is what it declared
      // — so a declared secret absent here means the two disagree, which is the
      // thing worth catching.
      const platform = ['CHORUS_DB_PASSWORD', 'CHORUS_MASTER_KEY', 'GITHUB_APP_PRIVATE_KEY']
      for (const name of platform) expect(Object.keys(env)).not.toContain(name)
      expect(Object.keys(env)).toContain('CHORUS_JOB_TOKEN')
      for (const name of adapter.requiredSecrets) {
        expect(Object.keys(env), `${name} was declared but is not present`).toContain(name)
      }
    })
  })
}
