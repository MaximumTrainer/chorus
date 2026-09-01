#!/usr/bin/env node
/**
 * Regenerates the delimited, generated blocks in the documentation.
 *
 * The README states how far along the project is, and a progress figure that
 * somebody typed is one nobody updates and nobody notices is wrong — which is
 * worse than no figure, because a reader trusts it. So the numbers live inside
 * `<!-- progress -->` markers and come from `website/src/status.json`, which
 * `pnpm site:record` records from the repository itself.
 *
 * A test asserts the block matches that file, so drift fails the build rather
 * than misleading a reader. This script is the one-command fix.
 *
 *   node scripts/sync-docs.mjs [--check]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const README = join(ROOT, 'README.md')

const status = JSON.parse(readFileSync(join(ROOT, 'website', 'src', 'status.json'), 'utf8'))

const phases = status.requirements.byPhase
  .filter((phase) => phase.phase !== 'Later' && phase.phase !== '0/1')
  .map(
    (phase) =>
      `| Phase ${phase.phase} | ${phase.total} | ${phase.withTests} |`,
  )
  .join('\n')

const block = `
| | |
|---|---|
| **Passing tests** | ${status.tests.total} |
| **HTTP routes**, each with a declared required role | ${status.routes.length} |
| **Catalogued requirements** | ${status.requirements.total} (${status.requirements.must} must-have) |
| **Requirements with a test that names them** | ${status.requirements.withPassingTests} — ${status.requirements.ids.map((id) => `\`${id}\``).join(', ')} |

| Phase | Requirements | With a test |
|---|---|---|
${phases}

<sub>Recorded from \`${status.recordedFromCommit}\` on ${status.recordedAt} by \`pnpm site:record\`. Regenerate this block with \`pnpm docs:sync\`.</sub>
`

const readme = readFileSync(README, 'utf8')
const [before, rest] = readme.split('<!-- progress -->')
if (rest === undefined) {
  console.error('README.md has no <!-- progress --> block to fill.')
  process.exit(1)
}
const after = rest.split('<!-- /progress -->')[1]
if (after === undefined) {
  console.error('README.md has no closing <!-- /progress --> marker.')
  process.exit(1)
}

const updated = `${before}<!-- progress -->${block}<!-- /progress -->${after}`

if (process.argv.includes('--check')) {
  if (updated !== readme) {
    console.error('README.md progress block is stale. Run: pnpm docs:sync')
    process.exit(1)
  }
  console.log('README.md progress block is current.')
  process.exit(0)
}

writeFileSync(README, updated, 'utf8')
console.log(
  `synced README.md progress block — ${status.tests.total} tests, ${status.routes.length} routes, ${status.requirements.withPassingTests}/${status.requirements.total} requirements`,
)
