import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * NFR-12 AC4 — the gate before the remote must reject what the remote rejects.
 *
 * `pre-push` exists so that a failure is found on the machine that caused it,
 * a minute after it was written, rather than four minutes later on a runner by
 * which time the author has moved on. That only holds while it runs the same
 * suites. When it runs a subset, it is worse than no gate: it reports success
 * over exactly the checks it does not perform, and CONTRIBUTING.md said it
 * "runs exactly what CI runs", which is the sentence that stops you looking.
 *
 * That is how #159 happened. A constructor parameter property is legal
 * everywhere in this repository except under Node's strip-only mode, which is
 * how the browser journeys execute TypeScript. `pnpm verify` passed, `pre-push`
 * passed, and CI's journeys refused the file at import — a red on `main` that
 * nothing local could have caught, because `pre-push` ran `verify` and CI ran
 * `verify` *and* the journeys.
 *
 * So the sets are compared rather than trusted. `test/nfr/strip-mode.test.ts`
 * catches that one class of syntax in a second without a browser; this is the
 * general form, and it is the one that keeps holding when the next divergence
 * is something else entirely.
 */

const ROOT = join(import.meta.dirname, '..', '..')
const preflight = readFileSync(join(ROOT, '.githooks', 'pre-push'), 'utf8')
const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'))

/**
 * The gates a shell script runs, as opposed to the setup around them.
 *
 * `pnpm install` and `pnpm exec playwright install` prepare a machine; they
 * cannot fail a change on its merits. What can is `verify`, `typecheck`,
 * `lint`, and the `test:*` scripts — so those are what the two sides are
 * compared on.
 */
function gatesIn(script: string): string[] {
  // `[a-z0-9]` rather than `[a-z]`: the first version of this matched
  // `pnpm test:e2e` as the bare `pnpm test`, and reported a gate missing that
  // nobody runs under that name.
  const found = [...script.matchAll(/\bpnpm\s+(verify|typecheck|lint|test(?::[a-z0-9]+)?)\b/g)].map(
    (match) => match[1]!,
  )
  return [...new Set(found)].sort()
}

/** The job that decides whether a pull request may merge. */
const verifyJob = workflow.jobs?.verify
const ciScript = (verifyJob?.steps ?? [])
  .map((step: { run?: string }) => step.run ?? '')
  .join('\n')

describe('NFR-12 AC4 the pre-push gate', () => {
  it('NFR-12 AC4: the CI job this is compared against is the one that gates a merge', () => {
    // Guards the comparison itself. If the job were renamed, every assertion
    // below would compare against an empty list and pass while proving nothing
    // — the failure mode this whole file exists to prevent, one level up.
    expect(verifyJob, 'ci.yml no longer has a `verify` job').toBeDefined()
    expect(
      gatesIn(ciScript).length,
      'the verify job runs no recognisable gate, so the pattern above has drifted',
    ).toBeGreaterThan(0)
  })

  it('NFR-12 AC4: pre-push runs every suite CI runs, so a push cannot pass a check CI fails', () => {
    const missing = gatesIn(ciScript).filter((gate) => !gatesIn(preflight).includes(gate))

    expect(
      missing,
      `CI runs ${missing.map((g) => `\`pnpm ${g}\``).join(', ')} and pre-push does not, so a ` +
        `change only those can reject reaches main before anybody sees it (#159)`,
    ).toEqual([])
  })
})
