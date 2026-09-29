import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

const root = join(import.meta.dirname, '..', '..', '..')
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8')

/**
 * NFR-1 AC1 — the image contains every workspace package's dependencies.
 *
 * The `deps` stage enumerates manifests by hand, because Docker's `COPY`
 * flattens a glob and would lose the directory structure pnpm needs. A
 * hand-maintained list is one that drifts, and this one did: four packages were
 * added to the workspace over two days without being added to the Dockerfile.
 *
 * The failure mode is what makes this worth a test rather than a convention.
 * The image still *builds*, and the container still *starts* — it dies later,
 * at the first import of the missing package, with a module-resolution error
 * that names a third-party module rather than the mistake. In CI it surfaced
 * as `container chorus-worker-1 is unhealthy`, which is three steps removed
 * from "somebody added a package".
 */
describe('NFR-1 AC1 application image', () => {
  const workspaces = ['packages', 'apps'].flatMap((group) =>
    readdirSync(join(root, group))
      .filter((name) => existsSync(join(root, group, name, 'package.json')))
      .map((name) => `${group}/${name}`),
  )

  it('NFR-1 AC1: there are workspace packages to check, so this gate is not vacuous', () => {
    expect(workspaces.length).toBeGreaterThan(5)
  })

  it.each(workspaces.map((w) => [w] as const))(
    'NFR-1 AC1: %s is installed into the image',
    (workspace) => {
      // The manifest, specifically: pnpm resolves the dependency graph from
      // these, and a package whose manifest never arrives gets no node_modules
      // of its own.
      expect(
        dockerfile,
        `add "COPY ${workspace}/package.json ${workspace}/" to the deps stage`,
      ).toContain(`COPY ${workspace}/package.json`)
    },
  )
})

/**
 * #153 — production processes run compiled JavaScript.
 *
 * `tsx` in the runtime path strips types without checking them and transpiles
 * the whole dependency graph on every boot. A compiled image fails at build
 * time, once and visibly, and cannot start with a type error in it at all.
 *
 * Asserted on the commands the image and the reference stack actually run,
 * because "we build to dist" is worth nothing if a service still starts from
 * `src/`.
 */
describe('NFR-1 AC1 compiled production image (#153)', () => {
  const compose = parseYaml(readFileSync(join(root, 'deploy', 'docker-compose.yml'), 'utf8')) as {
    services: Record<string, { build?: unknown; command?: string[] }>
  }
  const applicationServices = Object.entries(compose.services).filter(([, service]) => service.build)

  it('NFR-1 AC1: the reference stack builds some application services, so this gate is not vacuous', () => {
    expect(applicationServices.length).toBeGreaterThan(2)
  })

  it.each(applicationServices.map(([name, service]) => [name, service.command ?? []] as const))(
    'NFR-1 AC1: %s runs compiled output, not TypeScript through a runtime transpiler',
    (name, command) => {
      const rendered = command.join(' ')
      expect(rendered, `${name} must not start through tsx`).not.toMatch(/tsx/)
      expect(rendered, `${name} must run a file under dist/`).toMatch(/\/dist\/[^ ]+\.js/)
      expect(rendered, `${name} must not run source`).not.toMatch(/\/src\/[^ ]+\.ts/)
    },
  )

  it('NFR-1 AC1: the image default command runs compiled output', () => {
    const cmd = dockerfile.split('\n').filter((line) => line.startsWith('CMD')).at(-1) ?? ''
    expect(cmd).not.toMatch(/tsx/)
    expect(cmd).toMatch(/\/dist\/[^ "]+\.js/)
  })

  it('NFR-1 AC1: the image compiles before it runs, so a type error cannot reach a container', () => {
    expect(dockerfile).toMatch(/^RUN pnpm (run )?build:server/m)
  })
})
