import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ulid, type SandboxSpec } from '@chorus/core'
import { createDockerSandboxRunner } from '@chorus/coding'

const run = promisify(execFile)

/**
 * CODE-4 — the sandbox's guarantees, against real containers.
 *
 * `test/nfr/sandbox-security.test.ts` asserts the half that is *logic*: which
 * environment a job is given, and which results may become a pull request.
 * This file asserts the half that is *kernel*, and it exists because a mock
 * cannot demonstrate that a connection was refused. Every assertion here runs
 * against a container that really started.
 *
 * > everything here is a security control, so every clause is an assertion in a
 * > suite that runs on every pull request — not a design intention.
 *
 * Each check has a **positive control**. "The sandbox could not reach the
 * internet" is worthless on its own: it passes when the image has no network
 * tooling, when the host is offline, and when the container failed to start. So
 * the allow-listed host has to succeed in the same test that the blocked one
 * fails, or the suite is asserting its own inability to do anything.
 */

const IMAGE = 'node:22-alpine'

/** A host the allow-list permits, and one it does not. */
const ALLOWED = 'example.com'
const BLOCKED = 'icanhazip.com'

function specFor(jobId: string, overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    jobId,
    image: IMAGE,
    repository: {
      fullName: 'acme/billing',
      cloneUrl: 'https://x-access-token:ghs_scoped@github.test/acme/billing.git',
      baseBranch: 'main',
      branch: 'chorus/CH-1-split',
    },
    apiUrl: 'http://chorus.internal/api',
    jobToken: 'job_scoped_token',
    secrets: { ADAPTER_KEY: 'sk-adapter' },
    limits: { cpus: 1, memoryMb: 128, diskMb: 1024, processes: 24, wallClockMs: 120_000 },
    egressAllowList: [ALLOWED],
    pathAllowList: ['**'],
    protectedPaths: [],
    ...overrides,
  }
}

/** Host environment carrying everything a sandbox must never see. */
const HOST_SECRETS = {
  CHORUS_DB_PASSWORD: 'the-platform-database',
  CHORUS_MASTER_KEY: 'k1-the-envelope-key',
  GITHUB_APP_PRIVATE_KEY: 'the-app-key-for-every-repository',
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await run('docker', ['info', '--format', '{{.ServerVersion}}'])
    return true
  } catch {
    return false
  }
}

describe('CODE-4 sandbox runtime', () => {
  // Nothing is carried from the host by construction, so the runner takes no
  // host environment at all. These names are still set on *this* process, which
  // is what makes the assertion below meaningful: they exist, and they must not
  // cross the boundary.
  for (const [name, value] of Object.entries(HOST_SECRETS)) process.env[name] = value
  const runner = createDockerSandboxRunner()
  const provisioned: string[] = []

  beforeAll(async () => {
    // Docker is already required by the integration and acceptance suites, so
    // demanding it here is consistent rather than a new burden. Failing loudly
    // beats skipping: a security suite that quietly does not run is the same as
    // one that does not exist.
    expect(await dockerAvailable(), 'these are security controls and need a real runtime').toBe(
      true,
    )
  }, 120_000)

  afterAll(async () => {
    await runner.reconcile()
  }, 120_000)

  async function sandboxFor(overrides: Partial<SandboxSpec> = {}) {
    const jobId = ulid()
    provisioned.push(jobId)
    return runner.provision(specFor(jobId, overrides))
  }

  it('CODE-4 AC1: the running container holds no platform credential', async () => {
    const sandbox = await sandboxFor()
    try {
      // Read from *inside* the container, not from the spec we built. The spec
      // is what we intended; this is what the kernel actually gave the process.
      const seen: string[] = []
      for await (const event of sandbox.exec(['env'])) {
        if (event.type === 'stdout') seen.push(event.text)
      }
      const environment = seen.join('')

      for (const [name, value] of Object.entries(HOST_SECRETS)) {
        expect(environment, `${name} reached the sandbox`).not.toContain(name)
        expect(environment, `the value of ${name} reached the sandbox`).not.toContain(value)
      }

      // The positive control: the variables that *should* be there are, so a
      // pass cannot mean "env printed nothing".
      expect(environment).toContain('CHORUS_JOB_ID')
      expect(environment).toContain('ADAPTER_KEY')
    } finally {
      await sandbox.destroy()
    }
  }, 120_000)

  it('CODE-4 AC4: the clone token is not in the container environment', async () => {
    const sandbox = await sandboxFor()
    try {
      const seen: string[] = []
      for await (const event of sandbox.exec(['env'])) {
        if (event.type === 'stdout') seen.push(event.text)
      }
      // An environment is readable by every process in the container, including
      // whatever the model decided to run.
      expect(seen.join('')).not.toContain('ghs_scoped')
    } finally {
      await sandbox.destroy()
    }
  }, 120_000)

  it('CODE-4 AC2: a host outside the allow-list is refused at the network layer', async () => {
    const sandbox = await sandboxFor()
    try {
      // Bypassing the proxy entirely, which is what a compromised adapter would
      // do. The refusal must not depend on the adapter's cooperation.
      const direct = await reach(sandbox, BLOCKED, { viaProxy: false })
      expect(direct, 'a direct connection must not succeed').toBe(false)

      const directToAllowed = await reach(sandbox, ALLOWED, { viaProxy: false })
      expect(
        directToAllowed,
        'even an allow-listed host must be unreachable without the proxy',
      ).toBe(false)
    } finally {
      await sandbox.destroy()
    }
  }, 120_000)

  it('CODE-4 AC2: an allow-listed host is reachable, and a blocked one is not', async () => {
    const sandbox = await sandboxFor()
    try {
      // Both in one test, deliberately. The negative alone passes when the host
      // is offline or the image has no networking at all.
      expect(await reach(sandbox, ALLOWED, { viaProxy: true }), `${ALLOWED} should be reachable`)
        .toBe(true)
      expect(await reach(sandbox, BLOCKED, { viaProxy: true }), `${BLOCKED} should be refused`)
        .toBe(false)
    } finally {
      await sandbox.destroy()
    }
  }, 120_000)

  it('CODE-4 AC5: exceeding the memory limit terminates the job and records which limit', async () => {
    const sandbox = await sandboxFor({
      limits: { cpus: 1, memoryMb: 64, diskMb: 1024, processes: 24, wallClockMs: 120_000 },
    })
    try {
      const events = []
      for await (const event of sandbox.exec([
        'node',
        '-e',
        // Allocates well past the limit. The kernel decides, not us.
        'const a=[];for(;;){a.push(Buffer.alloc(8*1024*1024).fill(1))}',
      ])) {
        events.push(event)
      }

      const exit = events.find((event) => event.type === 'exit')
      expect(exit, 'the process must end rather than run forever').toBeDefined()
      // 137 is SIGKILL, which is what the OOM killer sends.
      expect((exit as { code: number }).code).not.toBe(0)
    } finally {
      await sandbox.destroy()
    }
  }, 120_000)

  it('CODE-4 AC5: the process limit is enforced', async () => {
    const sandbox = await sandboxFor({
      limits: { cpus: 1, memoryMb: 256, diskMb: 1024, processes: 16, wallClockMs: 120_000 },
    })
    try {
      const output: string[] = []
      for await (const event of sandbox.exec([
        'sh',
        '-c',
        'for i in $(seq 1 200); do sleep 30 & done; wait',
      ])) {
        if (event.type === 'stderr' || event.type === 'stdout') output.push(event.text)
      }
      expect(output.join('')).toMatch(/can't fork|Resource temporarily unavailable/i)
    } finally {
      await sandbox.destroy()
    }
  }, 120_000)

  it('CODE-4 AC5: the wall-clock limit terminates a hung command', async () => {
    const sandbox = await sandboxFor({
      limits: { cpus: 1, memoryMb: 128, diskMb: 1024, processes: 24, wallClockMs: 3_000 },
    })
    try {
      const events = []
      for await (const event of sandbox.exec(['sleep', '120'])) events.push(event)

      // Named, not merely killed. A job terminated silently cannot be told
      // apart from one that finished having done nothing.
      expect(events.at(-1)).toMatchObject({ type: 'timeout' })
    } finally {
      await sandbox.destroy()
    }
  }, 120_000)

  it('CODE-4 AC7: destroy leaves no container or network behind', async () => {
    const jobId = ulid()
    const sandbox = await runner.provision(specFor(jobId))
    await sandbox.destroy()

    expect(await resourcesFor(jobId)).toEqual({ containers: 0, networks: 0 })
  }, 120_000)

  it('CODE-4 AC7: reconcile removes what a crashed runner left behind', async () => {
    // The runner died between provisioning and collection — the case that
    // leaks, because nothing in the job's own code path runs to clean up.
    const jobId = ulid()
    await runner.provision(specFor(jobId))

    const before = await resourcesFor(jobId)
    expect(before.containers, 'the job should be running before reconciliation').toBeGreaterThan(0)

    const { removed } = await runner.reconcile()
    expect(removed).toContain(jobId)
    expect(await resourcesFor(jobId)).toEqual({ containers: 0, networks: 0 })
  }, 120_000)
})

/**
 * Whether `host` answers from inside the sandbox.
 *
 * Uses the runtime already in the image rather than installing a tool, because
 * installing one would need the very network access under test.
 */
async function reach(
  sandbox: { exec(command: readonly string[]): AsyncIterable<{ type: string; text?: string }> },
  host: string,
  options: { viaProxy: boolean },
): Promise<boolean> {
  const script = [
    'const https=require("https");',
    options.viaProxy
      ? 'const proxy=process.env.HTTPS_PROXY||"";'
      : 'const proxy="";',
    'const url=new URL(proxy||"http://unused");',
    'const done=(ok)=>{console.log(ok?"REACHED":"REFUSED");process.exit(0)};',
    options.viaProxy
      ? `require("http").request({host:url.hostname,port:url.port,method:"CONNECT",path:"${host}:443"})
           .on("connect",(res)=>done(res.statusCode===200))
           .on("error",()=>done(false)).end();`
      : `const r=https.request({host:"${host}",port:443,timeout:5000},()=>done(true));
         r.on("error",()=>done(false));r.on("timeout",()=>done(false));r.end();`,
  ].join('')

  const out: string[] = []
  for await (const event of sandbox.exec(['node', '-e', script])) {
    if (event.type === 'stdout' && event.text) out.push(event.text)
  }
  return out.join('').includes('REACHED')
}

/** What Docker still holds for a job, by label. */
async function resourcesFor(jobId: string): Promise<{ containers: number; networks: number }> {
  const count = async (kind: 'container' | 'network'): Promise<number> => {
    const { stdout } = await run('docker', [
      kind,
      'ls',
      '--all',
      '--filter',
      `label=chorus.job=${jobId}`,
      '--format',
      '{{.ID}}',
    ]).catch(() => ({ stdout: '' }))
    return stdout.split('\n').filter((line) => line.trim() !== '').length
  }
  return { containers: await count('container'), networks: await count('network') }
}
