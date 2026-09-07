import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SECRET_PATTERNS as ALL_CORE_PATTERNS,
  HIGH_CONFIDENCE_SECRET_PATTERNS as CORE_PATTERNS,
} from '@chorus/core'
import { SECRET_PATTERNS as HOOK_PATTERNS, findSecrets } from '../../scripts/pre-commit.mjs'

/**
 * The pre-commit gate (NFR-3, CLAUDE.md §7).
 *
 * Three checks, ordered by how hard each failure is to undo:
 *
 * - **Secrets.** A credential that reaches a commit is in the reflog, in every
 *   clone made afterwards, and in any fork — `--amend` does not remove it. It
 *   is the only one of the three a later commit cannot fix, so it goes first.
 * - **Lint**, on the staged files, while the change is still in your head.
 * - **The unit tests related to the staged code.**
 *
 * Speed is a correctness property. `.githooks/commit-msg` records the lesson —
 * a gate people skip because it is slow is a gate that is not run — and
 * `--no-verify` is one keystroke away.
 *
 * Every credential-shaped fixture below is assembled at runtime. A test file
 * that trips the scanner it is testing makes each future edit to it an argument
 * with the hook, and that argument is settled with `--no-verify`.
 */

const ROOT = join(import.meta.dirname, '..', '..')
const HOOK = join(ROOT, '.githooks', 'pre-commit')

/** A credential-shaped string that exists only once this runs. */
const token = (): string => `${'ghp'}_${'abcdefghijklmnopqrstuvwxyz0123'}`

describe('NFR-3 the pre-commit gate', () => {
  it('NFR-3: the hook exists and is wired to the tracked hooks directory', () => {
    expect(existsSync(HOOK), 'add .githooks/pre-commit').toBe(true)

    // `pnpm install` points git at `.githooks`; a hook nobody's git can see is
    // documentation, not a gate.
    const prepare = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts.prepare
    expect(prepare).toContain('core.hooksPath .githooks')
  })

  const shape = (patterns: readonly RegExp[]): string[] =>
    [...patterns].map((pattern) => `${pattern.source}::${pattern.flags}`).sort()

  it('NFR-3: the hook scans exactly the high-confidence patterns core classifies', () => {
    // One definition, two consumers, and the difference is deliberate: this
    // pins the hook to core's *subset* so a pattern added there is classified
    // on purpose rather than by whoever edits a list.
    expect(shape(HOOK_PATTERNS)).toEqual(shape(CORE_PATTERNS))

    // And the subset is genuinely narrower — if these ever became equal, the
    // generic patterns would be back and the hook would be unusable.
    expect(shape(CORE_PATTERNS).length).toBeLessThan(shape(ALL_CORE_PATTERNS).length)
  })

  it('NFR-3: ordinary authentication code does not trip the gate', () => {
    // The reason the hook uses a subset. These are real lines from this
    // repository, and the generic "a field that names itself" pattern matches
    // all of them — 76 across the tree. A gate that fires on `password:` in an
    // auth module is one people bypass, and a bypassed gate protects nothing.
    const ordinary = [
      'const ok = await verify(password, user.password_hash)',
      'client_secret: config.oauthClientSecret,',
      'headers: { authorization: `Bearer ${await token()}` },',
      "await t.execute('UPDATE users SET password_hash = $2 WHERE id = $1', [id, hash])",
      'refresh_token: row.refresh_token,',
    ]
    const found = findSecrets(ordinary.map((content, i) => ({ path: `auth${i}.ts`, content })))
    expect(found, found.map((f) => `${f.path}:${f.line}`).join(' | ')).toEqual([])
  })

  describe('NFR-3: what the scanner finds', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['a GitHub token', `const t = "${token()}"`],
      ['a Slack token', `SLACK=${'xoxb'}-${'1234567890-abcdefghijkl'}`],
      ['an AWS key id', `${'AKIA'}${'IOSFODNN7EXAMPLE'}`],
      ['a private key block', `-----BEGIN RSA ${'PRIVATE'} KEY-----x-----END RSA ${'PRIVATE'} KEY-----`],
      ['a JWT', `${'eyJhbGciOiJIUzI1NiJ9'}.${'eyJzdWIiOiIxMjM0NTY3ODkw'}.${'dozjgNryP4J3jVmNHl0w5N'}`],
      ['an AWS secret assignment', `aws_secret${'_access_key'} = ${'wJalrXUtnFEMIK7MDENG'}`],
    ]

    it.each(cases)('NFR-3: refuses %s', (name, content) => {
      const found = findSecrets([{ path: 'src/thing.ts', content }])
      expect(found.length, `not detected: ${name}`).toBeGreaterThan(0)
      expect(found[0]!.path).toBe('src/thing.ts')
      expect(found[0]!.line).toBeGreaterThan(0)
    })

    it('NFR-3: ordinary code and long identifiers are not secrets', () => {
      // The cost of over-broad patterns is false positives, and a hook that
      // cries wolf is one people learn to bypass. These are shapes this
      // repository is full of.
      const innocuous = [
        'export const MIGRATION_LOCK_KEY = 4_207_360_001',
        'const citationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV"',
        'expect(row.checksum).toMatch(/^[0-9a-f]{64}$/)',
        'https://github.com/MaximumTrainer/chorus/actions/runs/34057714484',
        'import { createIsolatedDatabase } from "@chorus/db"',
      ]
      const found = findSecrets(innocuous.map((content, i) => ({ path: `f${i}.ts`, content })))
      expect(found, found.map((f) => f.match).join(' | ')).toEqual([])
    })

    it('NFR-3: a line marked as a deliberate example is exempt, and only that line', () => {
      // Documentation legitimately contains credential *shapes*: `redaction.ts`
      // explains itself with a "password: hunter2" example, and every edit to
      // that file would otherwise be an argument with the hook — settled with
      // `--no-verify`, which switches the check off for the whole commit.
      const content = [
        `const shown = "${token()}" // pre-commit-allow: documentation example`,
        `const real = "${'ghp'}_${'zyxwvutsrqponmlkjihgfedcba9876'}"`,
      ].join('\n')

      const found = findSecrets([{ path: 'docs/example.ts', content }])

      // Per line, because a file-wide exemption blinds the file to the next
      // secret somebody adds to it.
      expect(found).toHaveLength(1)
      expect(found[0]!.line).toBe(2)
    })

    it('NFR-3: a marker on the line above works, for formats without comments', () => {
      // A recorded cassette is JSON, which cannot carry a trailing comment, and
      // is exactly where a deliberately fake token lives. Same convention as
      // `eslint-disable-next-line`.
      const content = [
        '{ "_note": "pre-commit-allow-next: a fake token, recorded for the fixture",',
        `  "token": "${token()}" }`,
      ].join('\n')

      expect(findSecrets([{ path: 'fixture.json', content }])).toEqual([])
    })

    it('NFR-3: the same-line marker does not quietly exempt the line after it', () => {
      // The two forms are separate for this reason. One marker covering both
      // lines would mean documenting an example also exempts whatever follows
      // it — and whatever follows it is where the real key would be.
      const content = [
        `const shown = "${token()}" // pre-commit-allow: documentation example`,
        `const real = "${'ghp'}_${'zyxwvutsrqponmlkjihgfedcba9876'}"`,
      ].join('\n')

      expect(findSecrets([{ path: 'docs/example.ts', content }])).toHaveLength(1)
    })

    it('NFR-3: the finding names the file and line, not the secret', () => {
      // The message reaches a terminal, a CI log and sometimes a screenshot. A
      // gate that prints the credential it caught has leaked it a second time.
      const secret = token()
      const [finding] = findSecrets([
        { path: 'deploy/env.ts', content: `a\nb\nconst k = "${secret}"` },
      ])
      expect(finding).toMatchObject({ path: 'deploy/env.ts', line: 3 })
      expect(JSON.stringify(finding)).not.toContain(secret)
    })
  })

  it('NFR-3: a commit carrying a credential is refused, and one without it is not', () => {
    // End to end, through real git, the same way the documentation gate is
    // tested. A hook that works when called directly and not when git calls it
    // is the failure this catches.
    const repo = mkdtempSync(join(tmpdir(), 'chorus-precommit-'))
    try {
      const git = (args: string[]): string =>
        execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' })

      git(['init', '--quiet'])
      mkdirSync(join(repo, '.githooks'), { recursive: true })
      writeFileSync(join(repo, '.githooks', 'pre-commit'), readFileSync(HOOK, 'utf8'), {
        mode: 0o755,
      })
      git(['config', 'core.hooksPath', join(repo, '.githooks')])
      // The hook resolves its tooling from the repository it lives in; point it
      // back at this checkout so the scratch repo needs no `node_modules`.
      git(['config', 'chorus.preCommitRoot', ROOT])

      const commit = (path: string, content: string): { accepted: boolean; output: string } => {
        writeFileSync(join(repo, path), content, 'utf8')
        git(['add', path])
        try {
          return {
            accepted: true,
            output: git([
              '-c',
              'user.email=suite@example.test',
              '-c',
              'user.name=Suite',
              '-c',
              'commit.gpgsign=false',
              'commit',
              '-m',
              'a change',
            ]),
          }
        } catch (error) {
          const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string }
          git(['reset', '--quiet'])
          return {
            accepted: false,
            output: `${String(failure.stdout ?? '')}${String(failure.stderr ?? '')}`,
          }
        }
      }

      const refused = commit('leak.txt', `token = "${token()}"\n`)
      expect(refused.accepted, 'a staged credential must stop the commit').toBe(false)
      expect(refused.output).toContain('leak.txt')
      expect(refused.output, 'the refusal must not repeat the credential').not.toContain(token())

      const allowed = commit('fine.txt', 'nothing sensitive here\n')
      expect(allowed.accepted, allowed.output).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
