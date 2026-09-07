import { describe, it, expect } from 'vitest'
import {
  buildSandboxEnvironment,
  validateSandboxResult,
  type SandboxSpec,
} from '@chorus/core'
import { createFakeSandbox } from '@chorus/testing'

/**
 * CODE-4 — the sandbox's security properties, as assertions.
 *
 * > This is the largest attack surface in the platform: it runs model-directed
 * > code against a real repository. Everything here is a security control, so
 * > every clause is an assertion in a suite that runs on every pull request —
 * > not a design intention.
 *
 * That sentence is why this file lives in `test/nfr` and blocks merges rather
 * than sitting beside the runner as an ordinary unit test. These are the
 * guarantees `architecture.md` §12.3 calls non-negotiable, and a guarantee
 * nobody re-checks on every change is a comment.
 *
 * What is asserted here is the half that is *logic*: which environment a job
 * gets, and which results are allowed to become a pull request. The half that
 * is *kernel* — egress refused at the network layer, resource limits enforced
 * by a real runtime, orphan reconciliation after a crash — is asserted against
 * a real container elsewhere, because a mock cannot demonstrate that a
 * connection was refused.
 */

const BASE_SPEC: SandboxSpec = {
  jobId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  image: 'ghcr.io/chorus/adapter-reference:1',
  repository: {
    fullName: 'acme/billing',
    cloneUrl: 'https://x-access-token:ghs_scoped@github.com/acme/billing.git',
    baseBranch: 'main',
    branch: 'chorus/CH-1-split-the-invoice-parser',
  },
  apiUrl: 'https://chorus.internal/api',
  jobToken: 'job_scoped_token',
  secrets: { ANTHROPIC_API_KEY: 'sk-ant-adapter' },
  limits: { cpus: 2, memoryMb: 4096, diskMb: 8192, processes: 256, wallClockMs: 1_800_000 },
  egressAllowList: ['github.com', 'api.anthropic.com', 'registry.npmjs.org'],
  pathAllowList: ['src/**', 'test/**'],
  protectedPaths: ['.github/workflows/**'],
}

/**
 * A host environment with everything a sandbox must never see.
 *
 * Deliberately realistic: these are the names the platform actually uses, so a
 * change that started passing `process.env` through would be caught by the
 * variables it would really leak rather than by invented ones.
 */
const HOST_ENV = {
  CHORUS_DB_PASSWORD: 'the-platform-database',
  CHORUS_DB_HOST: 'postgres.internal',
  CHORUS_MASTER_KEY: 'k1:the-envelope-key',
  CHORUS_ANTHROPIC_API_KEY: 'sk-ant-platform-wide',
  CHORUS_MODEL_API_KEY: 'the-platform-model-key',
  GITHUB_APP_PRIVATE_KEY: 'the-app-key-for-every-repository',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/root',
}

describe('CODE-4 sandbox security', () => {
  it('CODE-4 AC1: the environment contains no platform or workspace credential', () => {
    const env = buildSandboxEnvironment(BASE_SPEC, HOST_ENV)

    // Enumerated, not spot-checked. A test that looked for three known names
    // would pass the day somebody added a fourth.
    const values = Object.values(env).join('\n')
    for (const [name, value] of Object.entries(HOST_ENV)) {
      if (name === 'PATH' || name === 'HOME') continue
      expect(Object.keys(env), `${name} must not reach the sandbox`).not.toContain(name)
      expect(values, `the value of ${name} must not reach the sandbox`).not.toContain(value)
    }
  })

  it('CODE-4 AC1: the environment is exactly what was declared, and nothing else', () => {
    const env = buildSandboxEnvironment(BASE_SPEC, HOST_ENV)

    // An allow-list, asserted as a whole. The failure this prevents is not a
    // leak somebody added on purpose; it is a variable that arrived because the
    // construction was "host environment, minus the ones we thought of".
    expect(Object.keys(env).sort()).toEqual(
      ['ANTHROPIC_API_KEY', 'CHORUS_API_URL', 'CHORUS_JOB_ID', 'CHORUS_JOB_TOKEN', 'HOME', 'PATH'].sort(),
    )
  })

  it('CODE-4 AC1: only the secrets the adapter declared are injected', () => {
    // §12.2: an adapter declares `requiredSecrets`, and exactly those are
    // present. A second adapter's key in this one's environment is a
    // credential leak between adapters running on the same host.
    const env = buildSandboxEnvironment(
      { ...BASE_SPEC, secrets: { OPENAI_API_KEY: 'sk-other' } },
      HOST_ENV,
    )

    expect(env.OPENAI_API_KEY).toBe('sk-other')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('CODE-4 AC4: the environment names one repository and carries no other clone URL', () => {
    const env = buildSandboxEnvironment(BASE_SPEC, HOST_ENV)

    // The clone URL carries the scoped token, so it must not appear in the
    // environment at all: an environment is readable by every process in the
    // container, including whatever the model decided to run.
    expect(Object.values(env).join('\n')).not.toContain('ghs_scoped')
  })

  it('CODE-4 AC6: a diff larger than the limit blocks the pull request', () => {
    const verdict = validateSandboxResult(
      { changedPaths: ['src/a.ts'], addedLines: 50_000, removedLines: 0 },
      { ...BASE_SPEC, maxChangedLines: 2_000 },
    )

    expect(verdict.allowed).toBe(false)
    expect(verdict.violations.join(' ')).toMatch(/size/i)
  })

  it('CODE-4 AC6: a change outside the path allow-list blocks the pull request', () => {
    const verdict = validateSandboxResult(
      { changedPaths: ['src/ok.ts', 'infra/terraform/main.tf'], addedLines: 10, removedLines: 0 },
      BASE_SPEC,
    )

    expect(verdict.allowed).toBe(false)
    // Named, so the job's failure says which path and not merely that
    // validation failed — the person reading it has to decide whether to widen
    // the allow-list or reject the work.
    expect(verdict.violations.join(' ')).toContain('infra/terraform/main.tf')
  })

  it('CODE-4 AC6: modifying CI configuration is refused unless explicitly permitted', () => {
    const change = { changedPaths: ['.github/workflows/ci.yml'], addedLines: 3, removedLines: 1 }

    const refused = validateSandboxResult(change, {
      ...BASE_SPEC,
      pathAllowList: ['**'],
    })
    expect(refused.allowed).toBe(false)
    expect(refused.violations.join(' ')).toContain('.github/workflows/ci.yml')

    // Permitted only by saying so. A protected path that could be unlocked by
    // widening the ordinary allow-list would not be protected.
    const permitted = validateSandboxResult(change, {
      ...BASE_SPEC,
      pathAllowList: ['**'],
      protectedPaths: [],
    })
    expect(permitted.allowed).toBe(true)
  })

  it('CODE-4 AC6: a clean result inside the rules is allowed', () => {
    // The suite has to be able to say yes, or a runner that refused everything
    // would pass every test above.
    const verdict = validateSandboxResult(
      { changedPaths: ['src/billing/parse.ts', 'test/billing/parse.test.ts'], addedLines: 120, removedLines: 40 },
      BASE_SPEC,
    )

    expect(verdict.violations).toEqual([])
    expect(verdict.allowed).toBe(true)
  })

  it('CODE-4 AC6: a job that produced no change is refused rather than opening an empty pull request', () => {
    const verdict = validateSandboxResult(
      { changedPaths: [], addedLines: 0, removedLines: 0 },
      BASE_SPEC,
    )

    expect(verdict.allowed).toBe(false)
    expect(verdict.violations.join(' ')).toMatch(/no change/i)
  })


  it('CODE-4 AC1: the fake sandbox carries the same environment the runner builds', async () => {
    // Every adapter's contract test rests on this. A fake that handed out a
    // roomier environment than the runner does would let an adapter depend on
    // a variable that is absent in production, and the test suite would say it
    // was fine.
    const sandbox = createFakeSandbox(BASE_SPEC)
    const env = await sandbox.environment()

    expect(Object.keys(env).sort()).toEqual(
      Object.keys(buildSandboxEnvironment(BASE_SPEC, { PATH: '/usr/bin', HOME: '/home/agent' })).sort(),
    )
    expect(env.CHORUS_JOB_TOKEN).toBe(BASE_SPEC.jobToken)
    expect(Object.keys(env)).not.toContain('CHORUS_DB_PASSWORD')
  })

  it('CODE-4 AC2: the egress allow-list is carried on the spec, never left to the adapter', () => {
    // The enforcement is the runner's and is asserted against a real container
    // elsewhere. What belongs here is that the *policy* travels with the job:
    // an adapter is exactly the thing that might be compromised, so a
    // deployment that forgot to configure egress must not silently get none.
    expect(BASE_SPEC.egressAllowList.length).toBeGreaterThan(0)
    expect(() =>
      buildSandboxEnvironment({ ...BASE_SPEC, egressAllowList: [] }, HOST_ENV),
    ).toThrow(/egress/i)
  })
})
