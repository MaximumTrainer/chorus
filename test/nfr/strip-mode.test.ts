import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * NFR-12 AC4 — the local gate and CI must reject the same things.
 *
 * The browser journeys execute TypeScript under Node's **strip-only** mode,
 * which deletes type annotations and transforms nothing else. Syntax that has
 * to be *compiled into* runtime code is a `SyntaxError` there and legal
 * everywhere else in this repository — typecheck accepts it, lint accepts it,
 * every vitest project accepts it, and `pnpm verify` passes.
 *
 * That gap put a red on `main` (34045003790): a constructor parameter property
 * in `apps/api/src/chat-turn.ts`, which the journeys refused at import, before
 * a single test ran. Nothing local could have caught it, because `pnpm verify`
 * does not run them and `pre-push` runs only `verify`.
 *
 * This is the cheap half of the fix (#159): a second is enough to parse every
 * source file and refuse the syntax, without a browser anywhere. It does not
 * replace running the journeys — it catches one class, which happens to be the
 * class that has actually bitten.
 */

const ROOT = join(import.meta.dirname, '..', '..')

/** Syntax that strip-only mode cannot represent, and why each one matters. */
interface Offence {
  readonly line: number
  readonly what: string
}

function offences(source: string, fileName: string): Offence[] {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true)
  const found: Offence[] = []

  const at = (node: ts.Node): number =>
    parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1

  const visit = (node: ts.Node): void => {
    // `constructor(readonly x: string)` — an assignment disguised as a
    // parameter, so it cannot survive having its types removed.
    if (ts.isParameter(node) && node.modifiers?.length) {
      found.push({ line: at(node), what: 'constructor parameter property' })
    }
    // An enum is an object built at runtime, not a type.
    if (ts.isEnumDeclaration(node)) {
      found.push({ line: at(node), what: 'enum' })
    }
    // A namespace with a body is an IIFE assigning to an object.
    if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
      found.push({ line: at(node), what: 'namespace with a body' })
    }
    // `import x = require('y')` and `export = x` are CommonJS emit.
    if (ts.isImportEqualsDeclaration(node)) {
      found.push({ line: at(node), what: 'import-equals declaration' })
    }
    if (ts.isExportAssignment(node) && node.isExportEquals === true) {
      found.push({ line: at(node), what: 'export-equals assignment' })
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(parsed, visit)
  return found
}

/** Every `.ts` file under the shipped source directories. */
function sourceFiles(): string[] {
  const roots = ['apps', 'packages']
  const files: string[] = []

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
        files.push(full)
      }
    }
  }

  for (const root of roots) {
    for (const workspace of readdirSync(join(ROOT, root))) {
      const src = join(ROOT, root, workspace, 'src')
      try {
        if (statSync(src).isDirectory()) walk(src)
      } catch {
        // A workspace with no `src` is not a problem; the extension and the
        // website are built differently.
      }
    }
  }
  return files
}

describe('NFR-12 AC4 strip-only mode', () => {
  it('NFR-12 AC4: the detector catches the syntax that put a red on main', () => {
    // The gate has to be provably able to fail, or it becomes a test of
    // nothing the day the walk stops finding files. This is the exact shape
    // that broke 34045003790.
    const bad = offences(
      `export class TurnFailed extends Error {
         constructor(message: string, readonly runId: string) { super(message) }
       }`,
      'fixture.ts',
    )
    expect(bad.map((offence) => offence.what)).toContain('constructor parameter property')

    // and the corrected shape is accepted, or the gate would forbid the fix
    const good = offences(
      `export class TurnFailed extends Error {
         readonly runId: string
         constructor(message: string, runId: string) { super(message); this.runId = runId }
       }`,
      'fixture.ts',
    )
    expect(good).toEqual([])
  })

  it('NFR-12 AC4: the walk actually finds the source, so a pass means something', () => {
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(50)
    expect(files.some((file) => file.replace(/\\/g, '/').endsWith('apps/api/src/app.ts'))).toBe(true)
  })

  it('NFR-12 AC4: no source file uses syntax the browser journeys cannot parse', () => {
    const failures: string[] = []
    for (const file of sourceFiles()) {
      for (const offence of offences(readFileSync(file, 'utf8'), file)) {
        failures.push(`${file.slice(ROOT.length + 1)}:${offence.line} — ${offence.what}`)
      }
    }

    expect(
      failures,
      'these compile everywhere else and are a SyntaxError under `node --experimental-strip-types`',
    ).toEqual([])
  })
})
