import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

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
