import { describe, it, expect } from 'vitest'
import { detectRepository } from './detect.js'
import type { WalkedFile } from './walk.js'

/**
 * BRAIN-2 AC3, AC4 — what a repository tells you about itself.
 *
 * Everything here is read from files a repository already commits, and nothing
 * is inferred by a model. The same argument as the deterministic entity pass:
 * a `pnpm-lock.yaml` *means* pnpm, so certainty is free and a guess would be
 * both slower and worse.
 *
 * The consumer is the brief builder (CODE-2), which puts these in front of a
 * coding agent. A wrong test command is worse than a missing one — the agent
 * runs it, it fails for reasons unrelated to the change, and the run is wasted.
 */

const file = (path: string, text: string): WalkedFile => ({
  path,
  text,
  bytes: text.length,
  contentHash: 'x'.repeat(64),
})

const packageJson = (content: unknown): WalkedFile =>
  file('package.json', JSON.stringify(content, null, 2))

describe('BRAIN-2 repository detection', () => {
  it('BRAIN-2 AC4: the package manager comes from the lockfile, not the field', () => {
    // `packageManager` is aspirational and often stale; a lockfile is what the
    // repository actually has. Telling an agent to run `npm ci` in a pnpm
    // workspace wastes the whole run.
    const detected = detectRepository([
      packageJson({ name: 'app', packageManager: 'npm@10.0.0' }),
      file('pnpm-lock.yaml', 'lockfileVersion: 9.0\n'),
    ])

    expect(detected.conventions.packageManager).toBe('pnpm')
  })

  it('BRAIN-2 AC4: each lockfile names its manager', () => {
    for (const [lockfile, manager] of [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['package-lock.json', 'npm'],
      ['bun.lockb', 'bun'],
    ] as const) {
      const detected = detectRepository([packageJson({ name: 'app' }), file(lockfile, '')])
      expect(detected.conventions.packageManager, lockfile).toBe(manager)
    }
  })

  it('BRAIN-2 AC4: test, lint and format commands are read from the scripts', () => {
    const detected = detectRepository([
      packageJson({
        name: 'app',
        scripts: { test: 'vitest run', lint: 'eslint .', format: 'prettier --write .', build: 'tsc' },
      }),
      file('pnpm-lock.yaml', ''),
    ])

    // Prefixed with the manager's runner, because that is what the agent has
    // to type. `test` alone is not a runnable command.
    expect(detected.conventions.testCommand).toBe('pnpm run test')
    expect(detected.conventions.lintCommand).toBe('pnpm run lint')
    expect(detected.conventions.formatCommand).toBe('pnpm run format')
    expect(detected.conventions.buildCommand).toBe('pnpm run build')
  })

  it('BRAIN-2 AC4: a missing script is absent rather than guessed', () => {
    // A guessed command that does not exist fails in a way that looks like the
    // change broke something.
    const detected = detectRepository([packageJson({ name: 'app', scripts: {} })])

    expect(detected.conventions.testCommand).toBeNull()
    expect(detected.conventions.lintCommand).toBeNull()
  })

  it('BRAIN-2 AC4: contribution and agent instruction files are found', () => {
    const detected = detectRepository([
      packageJson({ name: 'app' }),
      file('CONTRIBUTING.md', '# How we work'),
      file('AGENTS.md', '# Rules for agents'),
      file('docs/CLAUDE.md', '# ignored, not at the root'),
    ])

    expect(detected.conventions.contributionGuide).toBe('CONTRIBUTING.md')
    // These are instructions an agent must follow, so finding them is not a
    // nicety — a run that ignores AGENTS.md is a run that breaks house rules.
    expect(detected.conventions.agentInstructions).toEqual(['AGENTS.md'])
  })

  it('BRAIN-2 AC4: CLAUDE.md at the root counts as agent instructions', () => {
    const detected = detectRepository([packageJson({ name: 'app' }), file('CLAUDE.md', '# Rules')])
    expect(detected.conventions.agentInstructions).toEqual(['CLAUDE.md'])
  })

  it('BRAIN-2 AC4: a monorepo is recognised, with its package globs', () => {
    const detected = detectRepository([
      packageJson({ name: 'root', private: true, workspaces: ['apps/*', 'packages/*'] }),
      file('package-lock.json', ''),
    ])

    expect(detected.conventions.monorepo).toEqual(['apps/*', 'packages/*'])
  })

  it('BRAIN-2 AC4: a pnpm workspace is recognised from its own file', () => {
    const detected = detectRepository([
      packageJson({ name: 'root' }),
      file('pnpm-lock.yaml', ''),
      file('pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n  - "packages/*"\n'),
    ])

    expect(detected.conventions.monorepo).toEqual(['apps/*', 'packages/*'])
  })

  it('BRAIN-2 AC4: a design system is found in the dependencies', () => {
    const detected = detectRepository([
      packageJson({ name: 'app', dependencies: { '@acme/design-system': '^2.0.0', react: '^18' } }),
    ])

    // A prototype that reuses the real design system looks like the product; one
    // that does not looks like a wireframe of it.
    expect(detected.designSystem).toMatchObject({ kind: 'package', name: '@acme/design-system' })
  })

  it('BRAIN-2 AC4: a local component library is found by path', () => {
    const detected = detectRepository([
      packageJson({ name: 'app' }),
      file('src/components/ui/button.tsx', 'export const Button = () => null'),
      file('src/components/ui/card.tsx', 'export const Card = () => null'),
    ])

    expect(detected.designSystem).toMatchObject({ kind: 'local', path: 'src/components/ui' })
  })

  it('BRAIN-2 AC4: the preview provider is read from its configuration file', () => {
    for (const [path, provider] of [
      ['vercel.json', 'vercel'],
      ['netlify.toml', 'netlify'],
      ['wrangler.toml', 'cloudflare'],
    ] as const) {
      const detected = detectRepository([packageJson({ name: 'app' }), file(path, '')])
      expect(detected.previewProvider, path).toBe(provider)
    }
  })

  it('BRAIN-2 AC4: a repository with none of these detects nothing rather than something', () => {
    // Reporting a framework nobody uses sends the brief builder down the wrong
    // path with confidence.
    const detected = detectRepository([file('main.go', 'package main')])

    expect(detected.framework).toBeNull()
    expect(detected.previewProvider).toBeNull()
    expect(detected.designSystem).toBeNull()
    expect(detected.routes).toEqual([])
  })

  it('BRAIN-2: an unparseable package.json does not take detection down', () => {
    // Some repositories commit a broken or templated manifest. Everything else
    // is still detectable, and a thrown error here would fail the whole index.
    const detected = detectRepository([
      file('package.json', '{ this is not json'),
      file('pnpm-lock.yaml', ''),
      file('CONTRIBUTING.md', '# How we work'),
    ])

    expect(detected.conventions.packageManager).toBe('pnpm')
    expect(detected.conventions.contributionGuide).toBe('CONTRIBUTING.md')
  })
})
