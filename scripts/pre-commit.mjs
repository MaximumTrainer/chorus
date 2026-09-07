#!/usr/bin/env node
/**
 * The pre-commit gate: secrets, lint, and the tests covering what is staged.
 *
 * Plain JavaScript with no workspace imports, deliberately. A commit hook runs
 * before anything is built and sometimes in a repository that has never had
 * `pnpm install` run in it, so a hook that needs a loader or a compiled package
 * is a hook that fails in the one situation it exists for. The cost of that
 * choice is a second copy of the secret patterns, and
 * `test/nfr/pre-commit.test.ts` pins it equal to `@chorus/core`'s so the two
 * cannot drift.
 *
 * Speed is a correctness property here. `.githooks/commit-msg` records the
 * lesson: a gate people skip because it is slow is a gate that is not run, and
 * `--no-verify` is one keystroke. So this looks only at staged files, runs only
 * the unit tests related to them, and leaves the full suite to `pre-push`.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Credential shapes precise enough to refuse a commit over.
 *
 * Kept identical to `@chorus/core`'s `HIGH_CONFIDENCE_SECRET_PATTERNS`, and
 * pinned equal by `test/nfr/pre-commit.test.ts`.
 *
 * It is a *subset* of what redaction scrubs, and the difference is the point.
 * Redaction is deliberately over-broad because a false positive there costs a
 * few characters of a trace. Here a false positive costs somebody's commit, and
 * the two generic patterns — a field that names itself, an `Authorization:`
 * header — match ordinary code: `password: input.password` is what an auth
 * module looks like, and this repository contains 76 such lines. A gate that
 * fires on those is one people learn to bypass with `--no-verify`, which turns
 * off the checks that would have caught a real key.
 *
 * What is left says "credential" and almost nothing else does: a recognisable
 * prefix followed by a long opaque body.
 */
export const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk|api|key|tok)[-_](?:live|test|prod|proj)?[-_]?[A-Za-z0-9]{16,}\b/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\baws_secret_access_key\s*[=:]\s*\S+/gi,
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
]

/**
 * How a line says it carries a credential *shape* on purpose.
 *
 * Documentation legitimately does: `redaction.ts` explains itself with a
 * "password: hunter2" example, and the redaction suite keeps a list of the
 * shapes it must scrub. Without a way to say so, every edit to those files is
 * an argument with this hook — and that argument is settled with
 * `--no-verify`, which switches the check off for everything else in the
 * commit too.
 *
 * Per line, never per file: a file-wide exemption blinds the file to the next
 * secret somebody adds to it.
 */
const ALLOW_MARKER = 'pre-commit-allow'

/**
 * The same, for formats that cannot carry a trailing comment.
 *
 * A recorded cassette is JSON, and it is exactly where a deliberately fake
 * token lives. Named separately from the same-line form so that neither
 * silently covers the other's line.
 */
const ALLOW_NEXT_MARKER = 'pre-commit-allow-next'

/**
 * Where each credential-shaped string is, and what shape it was.
 *
 * Returns the *location* and the pattern, never the value. The message reaches
 * a terminal, a CI log and sometimes a screenshot, and a gate that prints the
 * credential it caught has leaked it a second time.
 */
export function findSecrets(files) {
  const findings = []
  for (const { path, content } of files) {
    const lines = content.split('\n')
    for (const pattern of SECRET_PATTERNS) {
      // Fresh, because these carry `g` and a shared `lastIndex` between files
      // would skip matches in the file that follows a long one.
      const scanner = new RegExp(pattern.source, pattern.flags)
      let match
      while ((match = scanner.exec(content)) !== null) {
        const line = content.slice(0, match.index).split('\n').length
        // Any line the match spans: a PEM key covers several, and the note
        // belongs where a reader would write it.
        const spanned = lines.slice(line - 1, line - 1 + match[0].split('\n').length)
        const allowedHere = spanned.some(
          (text) => text.includes(ALLOW_MARKER) && !text.includes(ALLOW_NEXT_MARKER),
        )
        // The two forms are separate on purpose. If one marker covered both its
        // own line and the next, exempting a documented example would silently
        // exempt whatever followed it — and "whatever followed it" is where the
        // real key would be.
        const allowedFromAbove = (lines[line - 2] ?? '').includes(ALLOW_NEXT_MARKER)

        if (!allowedHere && !allowedFromAbove) {
          findings.push({ path, line, match: pattern.source.slice(0, 32) })
        }
        if (match[0].length === 0) scanner.lastIndex += 1
      }
    }
  }
  return findings
}

const isMain = process.argv[1] && process.argv[1].endsWith('pre-commit.mjs')
if (isMain) main()

function main() {
  const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim()

  /**
   * `--all` scans every tracked file and checks nothing else.
   *
   * CI runs this, because a hook is advice and `--no-verify` is one keystroke.
   * The lint and test checks are omitted deliberately: CI already runs them
   * across the whole repository, and repeating them here would say the same
   * thing twice and take minutes doing it.
   */
  if (process.argv.includes('--all')) {
    const tracked = git(['ls-files']).split('\n').filter(Boolean)
    const findings = findSecrets(readAll(git, tracked, { fromIndex: false }))
    if (findings.length === 0) {
      process.stdout.write(`scanned ${tracked.length} tracked files; no credential shapes.\n`)
      process.exit(0)
    }
    fail([
      'A tracked file contains something shaped like a credential.',
      '',
      ...findings.map((f) => `  ${f.path}:${f.line} — matches /${f.match}/`),
      '',
      'This ran in CI, so the commit hook was bypassed or the file predates it.',
      'If it only looks like a credential, mark the line:',
      '',
      '    // pre-commit-allow: why this shape is here',
      '    "_note": "pre-commit-allow-next: ..."   // for JSON and YAML',
    ])
  }

  // Added, copied, modified or renamed — never deleted, which has no content to
  // scan and no tests to run.
  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  if (staged.length === 0) process.exit(0)

  const problems = []

  // 1. Secrets. First, because it is the only failure here that cannot be
  //    undone by a later commit.
  const contents = readAll(git, staged, { fromIndex: true })

  for (const finding of findSecrets(contents)) {
    problems.push(
      `  ${finding.path}:${finding.line} — matches a credential shape (/${finding.match}/)`,
    )
  }

  if (problems.length > 0) {
    fail([
      'A staged file contains something shaped like a credential.',
      '',
      ...problems,
      '',
      'A commit is not undoable: the value stays in the reflog, in every clone',
      'made afterwards, and `--amend` does not remove it. Take it out of the',
      'file, and rotate it if it was ever real.',
      '',
      'If it only looks like a credential — an example in a comment, a fixture',
      'for the redaction suite — say so on that line:',
      '',
      '    const shown = "ghp_..."   // pre-commit-allow: documentation example',
      '',
      'That exempts the line and nothing else, and leaves a note for whoever',
      'reads it next.',
    ])
  }

  const root = repoRoot(git)
  const sources = staged.filter((path) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(path))
  if (sources.length === 0 || !existsSync(join(root, 'node_modules'))) process.exit(0)

  // 2. Lint, on the staged files alone. Whole-repository lint is `verify`'s.
  const lint = run(root, 'eslint', ['--no-warn-ignored', '--max-warnings', '0', ...sources])
  if (lint.status !== 0) {
    fail([
      'Lint failed on the staged files.',
      '',
      lint.output.trim(),
      '',
      'Fixable ones: pnpm exec eslint --fix ' + sources.slice(0, 3).join(' '),
    ])
  }

  // 3. The unit tests that cover what is staged. `related` resolves the import
  //    graph, so editing a module runs the tests that reach it. Unit only: the
  //    other projects need Postgres, and a hook that needs Docker running is a
  //    hook that fails on a plane.
  const tests = run(root, 'vitest', [
    'related',
    '--run',
    '--project',
    'unit',
    '--passWithNoTests',
    ...sources,
  ])
  if (tests.status !== 0) {
    fail([
      'A unit test covering the staged code is failing.',
      '',
      tests.output.trim().split('\n').slice(-25).join('\n'),
      '',
      'Only the unit project runs here, and only the tests related to what you',
      'staged. The rest of the suite runs on push.',
    ])
  }

  process.exit(0)
}

/**
 * The checkout whose tooling should run.
 *
 * Normally the repository being committed to. The suite points this elsewhere
 * with `chorus.preCommitRoot`, so the hook can be exercised in a scratch
 * repository that has no `node_modules` of its own.
 */
function repoRoot(git) {
  try {
    const configured = git(['config', '--get', 'chorus.preCommitRoot'])
    if (configured) return configured
  } catch {
    // Not configured, which is the normal case.
  }
  return git(['rev-parse', '--show-toplevel'])
}

/**
 * The content of each file, skipping what cannot be read as text.
 *
 * From the index when committing — `git add -p` means the staged content and
 * the working tree can differ, and what is being committed is what matters —
 * and from disk when scanning a checkout.
 */
function readAll(git, paths, { fromIndex }) {
  const files = []
  for (const path of paths) {
    try {
      files.push({ path, content: fromIndex ? git(['show', `:${path}`]) : readFileSync(path, 'utf8') })
    } catch {
      // A binary file, a broken symlink, or a path git can no longer resolve.
      // None of them can carry a credential this scanner would recognise.
    }
  }
  return files
}

function run(root, bin, args) {
  const suffix = process.platform === 'win32' ? '.cmd' : ''
  const executable = join(root, 'node_modules', '.bin', `${bin}${suffix}`)
  if (!existsSync(executable)) return { status: 0, output: '' }

  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

function fail(lines) {
  process.stderr.write(`\npre-commit: refused.\n\n${lines.join('\n')}\n\n`)
  process.stderr.write('To bypass in a genuine emergency: git commit --no-verify (and say why).\n\n')
  process.exit(1)
}
