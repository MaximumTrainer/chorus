import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import {
  buildSandboxEnvironment,
  type Sandbox,
  type SandboxChange,
  type SandboxOutput,
  type SandboxRunner,
  type SandboxSpec,
} from '@chorus/core'

const run = promisify(execFile)

/**
 * A sandbox runner backed by an OCI runtime (CODE-4, ADR-0014, ADR-0019).
 *
 * ADR-0014 makes the runtime deployment configuration: rootless Podman by
 * default, gVisor where workspaces share hardware, rootless Docker supported.
 * All three speak the same command surface, so this drives whichever binary it
 * is given rather than a client library — a library would be a dependency that
 * speaks to exactly one of them, which is the argument that keeps the
 * OpenAI-compatible provider on `fetch`.
 *
 * Egress is enforced by topology, per ADR-0019: the sandbox joins an
 * **internal** network with no route off the host, and the only thing it can
 * reach is a proxy that is dual-homed onto a second network and refuses any
 * host outside the allow-list. The important half is the internal network. A
 * proxy alone would be enforcement by the adapter's cooperation, and an adapter
 * is exactly the thing that might be compromised.
 */

export interface DockerSandboxOptions {
  /** `docker`, `podman`, or a wrapper. ADR-0014 makes this configuration. */
  readonly binary?: string
  /** The image the egress proxy runs. Needs a Node runtime and nothing else. */
  readonly proxyImage?: string
}

/** Every resource this runner creates carries these, so nothing is orphaned. */
const MANAGED_LABEL = 'chorus.managed=true'
const JOB_LABEL = 'chorus.job'

const PROXY_PORT = 3128

/**
 * The egress proxy, inline.
 *
 * Inline rather than an image we build, so a deployment needs no registry entry
 * and no build step for a security control. It is small enough to read in one
 * sitting, which for a component whose job is refusing connections is the point.
 *
 * It answers CONNECT only. Everything else gets 403: a coding job reaches
 * package registries and git hosts over TLS, and a proxy that also forwarded
 * plaintext would be a second, quieter path out.
 */
const PROXY_SCRIPT = `
const net = require('net'), http = require('http');
const allow = (process.env.CHORUS_EGRESS_ALLOW || '').split(',').filter(Boolean);
// Suffix match, so 'github.com' covers 'codeload.github.com' but never
// 'notgithub.com' — the dot is what makes it a subdomain rather than a prefix.
const permitted = (h) => allow.some((a) => h === a || h.endsWith('.' + a));
const server = http.createServer((_req, res) => { res.writeHead(403); res.end('chorus: plaintext refused'); });
server.on('connect', (req, socket, head) => {
  const [host, port] = String(req.url).split(':');
  if (!permitted(host)) { socket.end('HTTP/1.1 403 Forbidden\\r\\n\\r\\n'); return; }
  const upstream = net.connect(Number(port) || 443, host, () => {
    socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream);
  });
  upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\\r\\n\\r\\n'));
  socket.on('error', () => upstream.destroy());
});
server.listen(${PROXY_PORT}, '0.0.0.0');
`

function jobResources(jobId: string): {
  network: string
  externalNetwork: string
  proxy: string
  sandbox: string
} {
  const short = jobId.slice(-12).toLowerCase()
  return {
    network: `chorus-int-${short}`,
    externalNetwork: `chorus-ext-${short}`,
    proxy: `chorus-proxy-${short}`,
    sandbox: `chorus-sandbox-${short}`,
  }
}

export function createDockerSandboxRunner(
  options: DockerSandboxOptions = {},
): SandboxRunner {
  const binary = options.binary ?? 'docker'
  const proxyImage = options.proxyImage ?? 'node:22-alpine'

  const cli = async (args: readonly string[]): Promise<string> => {
    const { stdout } = await run(binary, [...args], { maxBuffer: 32 * 1024 * 1024 })
    return stdout
  }

  /** Best effort: teardown must not fail a job that otherwise succeeded. */
  const quietly = async (args: readonly string[]): Promise<void> => {
    await cli(args).catch(() => '')
  }

  async function destroyJob(jobId: string): Promise<void> {
    const names = jobResources(jobId)
    await quietly(['rm', '-f', names.sandbox])
    await quietly(['rm', '-f', names.proxy])
    // Networks refuse removal while an endpoint is attached, so containers go
    // first. Ordered rather than retried, because the ordering is knowable.
    await quietly(['network', 'rm', names.network])
    await quietly(['network', 'rm', names.externalNetwork])
  }

  return {
    async provision(spec: SandboxSpec): Promise<Sandbox> {
      const names = jobResources(spec.jobId)
      const label = `${JOB_LABEL}=${spec.jobId}`

      // Built here, from the same allow-list construction the pure suite
      // enumerates, so what a real container gets and what that suite asserts
      // cannot drift.
      const environment = buildSandboxEnvironment(spec)

      try {
        // `--internal` is the control. It gives the network no route off the
        // host, so egress is refused by the kernel rather than by anything the
        // job chooses to honour.
        await cli([
          'network', 'create', '--internal',
          '--label', MANAGED_LABEL, '--label', label,
          names.network,
        ])
        await cli([
          'network', 'create',
          '--label', MANAGED_LABEL, '--label', label,
          names.externalNetwork,
        ])

        await cli([
          'run', '-d', '--name', names.proxy,
          '--label', MANAGED_LABEL, '--label', label,
          '--network', names.externalNetwork,
          '--env', `CHORUS_EGRESS_ALLOW=${spec.egressAllowList.join(',')}`,
          // The proxy is not the sandbox and holds no job credential; it is
          // limited anyway, because a runaway proxy takes the host with it.
          '--memory', '128m', '--pids-limit', '64',
          proxyImage, 'node', '-e', PROXY_SCRIPT,
        ])
        // Dual-homed: reachable from the sandbox, and able to reach out. This
        // second attachment is the *only* route off the internal network.
        await cli(['network', 'connect', names.network, names.proxy])

        const proxyUrl = `http://${names.proxy}:${PROXY_PORT}`
        const envArgs = Object.entries({
          ...environment,
          // Offered to well-behaved tooling. Not relied on: the internal
          // network is what stops a job that ignores these.
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          https_proxy: proxyUrl,
        }).flatMap(([name, value]) => ['--env', `${name}=${value}`])

        await cli([
          'run', '-d', '--name', names.sandbox,
          '--label', MANAGED_LABEL, '--label', label,
          '--network', names.network,
          '--memory', `${spec.limits.memoryMb}m`,
          // Without this, the kernel swaps instead of killing and the memory
          // limit becomes a performance setting rather than a limit.
          '--memory-swap', `${spec.limits.memoryMb}m`,
          '--cpus', String(spec.limits.cpus),
          '--pids-limit', String(spec.limits.processes),
          ...envArgs,
          '--workdir', '/workspace',
          spec.image,
          // Held open by the runner rather than by the job, so a job that exits
          // does not take its own workspace with it before collection.
          'sleep', String(Math.ceil(spec.limits.wallClockMs / 1000) + 60),
        ])
      } catch (error) {
        // A half-provisioned job leaks exactly the resources AC7 exists to
        // prevent, and it leaks them in the case nobody is watching.
        await destroyJob(spec.jobId)
        throw error
      }

      return dockerSandbox({
        binary,
        spec,
        containerName: names.sandbox,
        environment,
        destroy: () => destroyJob(spec.jobId),
      })
    },

    async reconcile(): Promise<{ removed: readonly string[] }> {
      // By label, not by a list the runner remembers. A runner that crashed
      // remembers nothing, which is the only case this exists for.
      const stdout = await cli([
        'ps', '-a', '--filter', `label=${MANAGED_LABEL}`,
        '--format', `{{.Label "${JOB_LABEL}"}}`,
      ]).catch(() => '')
      const networks = await cli([
        'network', 'ls', '--filter', `label=${MANAGED_LABEL}`,
        '--format', `{{.Label "${JOB_LABEL}"}}`,
      ]).catch(() => '')

      const jobIds = [
        ...new Set(
          `${stdout}\n${networks}`
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== ''),
        ),
      ]

      for (const jobId of jobIds) await destroyJob(jobId)
      return { removed: jobIds }
    },
  }
}

function dockerSandbox(deps: {
  binary: string
  spec: SandboxSpec
  containerName: string
  environment: Readonly<Record<string, string>>
  destroy: () => Promise<void>
}): Sandbox {
  const { binary, spec, containerName } = deps

  return {
    jobId: spec.jobId,

    async write(path, content) {
      // Through stdin rather than an argument: a brief is tens of kilobytes and
      // arguments have a length limit that a long document quietly exceeds.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(binary, [
          'exec', '-i', containerName,
          'sh', '-c', `mkdir -p "$(dirname '${path}')" && cat > '${path}'`,
        ])
        child.on('error', reject)
        child.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`write ${path} exited ${code}`)),
        )
        child.stdin.end(content)
      })
    },

    async read(path) {
      const { stdout } = await run(binary, ['exec', containerName, 'cat', path], {
        maxBuffer: 32 * 1024 * 1024,
      })
      return stdout
    },

    async *exec(command: readonly string[]): AsyncIterable<SandboxOutput> {
      const child = spawn(binary, ['exec', containerName, ...command])

      const queue: SandboxOutput[] = []
      let resolveNext: (() => void) | undefined
      let finished = false

      const push = (event: SandboxOutput): void => {
        queue.push(event)
        resolveNext?.()
        resolveNext = undefined
      }

      child.stdout.on('data', (chunk: Buffer) => push({ type: 'stdout', text: chunk.toString() }))
      child.stderr.on('data', (chunk: Buffer) => push({ type: 'stderr', text: chunk.toString() }))

      // The wall-clock limit, enforced by the runner rather than by the job
      // (AC5). A job asked to police its own timeout is a job that will not.
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        push({ type: 'timeout', limitMs: spec.limits.wallClockMs })
        finished = true
        resolveNext?.()
      }, spec.limits.wallClockMs)

      child.on('close', (code) => {
        clearTimeout(timer)
        if (!finished) {
          push({ type: 'exit', code: code ?? -1 })
          finished = true
        }
        resolveNext?.()
      })

      for (;;) {
        while (queue.length > 0) yield queue.shift()!
        if (finished) return
        await new Promise<void>((resolve) => {
          resolveNext = resolve
        })
      }
    },

    async diff() {
      const { stdout } = await run(
        binary,
        ['exec', containerName, 'sh', '-c', 'git diff HEAD 2>/dev/null || true'],
        { maxBuffer: 64 * 1024 * 1024 },
      ).catch(() => ({ stdout: '' }))
      return stdout
    },

    async change(): Promise<SandboxChange> {
      const { stdout } = await run(
        binary,
        ['exec', containerName, 'sh', '-c', 'git diff --numstat HEAD 2>/dev/null || true'],
        { maxBuffer: 32 * 1024 * 1024 },
      ).catch(() => ({ stdout: '' }))

      const changedPaths: string[] = []
      let addedLines = 0
      let removedLines = 0
      for (const line of stdout.split('\n')) {
        const [added, removed, path] = line.trim().split(/\s+/)
        if (!path) continue
        changedPaths.push(path)
        // `-` where git could not count, on a binary file. Counted as zero
        // rather than as NaN, which would poison the size check silently.
        addedLines += Number.parseInt(added ?? '0', 10) || 0
        removedLines += Number.parseInt(removed ?? '0', 10) || 0
      }
      return { changedPaths, addedLines, removedLines }
    },

    async environment() {
      return deps.environment
    },

    destroy: deps.destroy,
  }
}
