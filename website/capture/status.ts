import { it } from 'vitest'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { routeTable } from '@chorus/api'

/**
 * Records the project's real state for the website: the live route table, the
 * requirement catalogue parsed from architecture.md, and the test counts from
 * the runs in website/capture/raw.
 *
 * Nothing here is hand-maintained. A site that claims a number someone typed in
 * is a site that will eventually be wrong and nobody will notice; every figure
 * shown comes from the repository itself.
 */

const ROOT = join(import.meta.dirname, '..', '..')

interface Requirement {
  readonly id: string
  readonly priority: string
  readonly summary: string
  readonly component: string
  readonly phase: string
}

/**
 * Requirement ids proven by at least one test that *names* them.
 *
 * Deliberately reads only the titles of `it`/`test`/`describe`, never the file
 * as a whole. Scanning whole files counted ids that merely appear in a comment
 * — a note reading "deferred until TASK-1" was taken as evidence that TASK-1
 * was built — which would have put five false claims on the front page. This is
 * the rule CLAUDE.md §5 already states: `pnpm test --grep TASK-4` must run
 * everything proving TASK-4, so the id belongs in the test name or it does not
 * count.
 */
function requirementsWithTests(): Set<string> {
  const files = [
    'apps/api/test/acceptance',
    'apps/api/test/integration',
    'packages/core/src',
    'packages/db/test/integration',
    'packages/llm/test/integration',
    'packages/testing/src',
    'test/nfr',
  ]
  const found = new Set<string>()
  const walk = (dir: string): void => {
    // A directory that does not exist yet is not an error: the list above names
    // places tests will live, and several packages have none so far.
    let entries: ReturnType<typeof readdirSync<{ withFileTypes: true }>>
    try {
      entries = readdirSync(join(ROOT, dir), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const next = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        walk(next)
      } else if (entry.name.endsWith('.test.ts')) {
        const text = readFileSync(join(ROOT, next), 'utf8')
        for (const title of text.matchAll(/\b(?:it|test|describe)\(\s*(['"`])([\s\S]*?)\1/g)) {
          for (const id of title[2]!.matchAll(/\b([A-Z]{2,6}-\d{1,2})\b/g)) found.add(id[1]!)
        }
      }
    }
  }
  for (const dir of files) walk(dir)
  return found
}

function parseCatalogue(): Requirement[] {
  const text = readFileSync(join(ROOT, 'architecture.md'), 'utf8')
  const rows = text.matchAll(
    /^\|\s*([A-Z]{2,6}-\d{1,2})\s*\|\s*([MSC])\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/gm,
  )
  const seen = new Set<string>()
  const out: Requirement[] = []
  for (const row of rows) {
    const id = row[1]!
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      priority: row[2]!,
      summary: row[3]!,
      component: row[4]!,
      phase: row[5]!.trim(),
    })
  }
  return out
}

it('records project status for the website', () => {
  const counts = ['core', 'acceptance', 'nfr'].map((name) => {
    const raw = JSON.parse(
      readFileSync(join(import.meta.dirname, 'raw', `${name}.json`), 'utf8'),
    ) as { numPassedTests: number; numTotalTests: number }
    return { name, passed: raw.numPassedTests, total: raw.numTotalTests }
  })

  const routes = routeTable().map((definition) => ({
    method: definition.method,
    path: definition.path,
    summary: definition.summary,
    auth:
      definition.auth.kind === 'workspace'
        ? { kind: 'workspace', role: definition.auth.role }
        : { kind: definition.auth.kind },
  }))

  const catalogue = parseCatalogue()
  const proven = requirementsWithTests()
  const done = catalogue.filter((requirement) => proven.has(requirement.id))

  // Recorded, and stamped with when and from what.
  //
  // These figures need a database to regenerate, so the deploy workflow cannot
  // refresh them and they *will* lag the code between runs of
  // `pnpm site:record`. Showing the commit they came from makes that lag
  // visible instead of leaving the page quietly wrong — which is the whole
  // failure this file exists to avoid.
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim()

  const status = {
    generatedFrom: 'the repository itself — see website/capture',
    recordedAt: new Date().toISOString().slice(0, 10),
    recordedFromCommit: commit,
    tests: {
      byLayer: counts,
      total: counts.reduce((sum, layer) => sum + layer.total, 0),
    },
    routes,
    requirements: {
      total: catalogue.length,
      must: catalogue.filter((r) => r.priority === 'M').length,
      withPassingTests: done.length,
      ids: done.map((r) => r.id).sort(),
      byPhase: [...new Set(catalogue.map((r) => r.phase))].sort().map((phase) => ({
        phase,
        total: catalogue.filter((r) => r.phase === phase).length,
        withTests: catalogue.filter((r) => r.phase === phase && proven.has(r.id)).length,
      })),
    },
  }

  writeFileSync(
    join(import.meta.dirname, '..', 'src', 'status.json'),
    `${JSON.stringify(status, null, 2)}\n`,
    'utf8',
  )
  console.log(
    `routes=${routes.length} requirements=${catalogue.length} proven=${done.length} tests=${status.tests.total}`,
  )
})
