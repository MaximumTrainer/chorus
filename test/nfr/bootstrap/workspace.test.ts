import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'

const root = join(import.meta.dirname, '..', '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const readJson = (p: string) => JSON.parse(read(p))

/**
 * NFR-12 — Developer experience.
 * These assertions are the executable form of "a fresh clone reaches a running
 * system with one command", and of the rule that local `verify` and CI cannot
 * drift apart (NFR-12 AC4, AC6).
 */
describe('NFR-12 workspace bootstrap', () => {
  it('NFR-12: the workspace declares the apps and packages globs from architecture.md §7', () => {
    const ws = parseYaml(read('pnpm-workspace.yaml'))
    expect(ws.packages).toContain('apps/*')
    expect(ws.packages).toContain('packages/*')
  })

  it('NFR-12: the toolchain is pinned so every contributor and CI agree', () => {
    const pkg = readJson('package.json')
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/)
    expect(pkg.engines?.node).toBeDefined()
  })

  it('NFR-12 AC4: verify runs typecheck, lint, every test layer and the non-functional suites', () => {
    const { scripts } = readJson('package.json')
    expect(scripts.verify).toBeDefined()
    for (const step of ['typecheck', 'lint', 'test:acceptance', 'test:nfr']) {
      expect(scripts[step], `missing script: ${step}`).toBeDefined()
      expect(scripts.verify, `verify must run ${step}`).toContain(step)
    }
  })

  it('NFR-12 AC4: CI runs the same verify command, so local and CI reject the same changes', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain('pnpm verify')
  })

  it('NFR-12 AC1: CI bootstraps from a fresh clone with the documented commands', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain('pnpm install')
    expect(ci).toMatch(/actions\/checkout/)
  })

  it('NFR-12 AC6: every quick-start command in CONTRIBUTING.md is executed by CI', () => {
    const contributing = read('CONTRIBUTING.md')
    const ci = read('.github/workflows/ci.yml')
    const quickStart = contributing.split('<!-- quick-start -->')[1]?.split('<!-- /quick-start -->')[0]
    expect(quickStart, 'CONTRIBUTING.md must delimit its quick-start block').toBeDefined()

    const commands = [...quickStart!.matchAll(/^\s*(pnpm [^\n#]+)$/gm)].map((m) => m[1].trim())
    expect(commands.length, 'quick-start must document at least one command').toBeGreaterThan(0)
    for (const command of commands) {
      expect(ci, `CONTRIBUTING documents "${command}" but CI never runs it`).toContain(command)
    }
  })

  it('NFR-12: every workspace package extends the shared tsconfig preset', () => {
    for (const dir of ['apps', 'packages']) {
      if (!existsSync(join(root, dir))) continue
      for (const name of readdirSync(join(root, dir))) {
        const tsconfigPath = join(dir, name, 'tsconfig.json')
        if (!existsSync(join(root, tsconfigPath))) continue
        const tsconfig = readJson(tsconfigPath)
        expect(tsconfig.extends, `${tsconfigPath} must extend the shared preset`).toContain(
          '@chorus/config',
        )
      }
    }
  })

  it('NFR-12: every workspace package is named @chorus/<directory>', () => {
    for (const dir of ['apps', 'packages']) {
      if (!existsSync(join(root, dir))) continue
      for (const name of readdirSync(join(root, dir))) {
        const manifestPath = join(dir, name, 'package.json')
        if (!existsSync(join(root, manifestPath))) continue
        expect(readJson(manifestPath).name).toBe(`@chorus/${name}`)
      }
    }
  })
})
