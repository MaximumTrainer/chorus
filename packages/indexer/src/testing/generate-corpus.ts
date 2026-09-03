import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * A synthetic benchmark repository (BRAIN-2 AC6).
 *
 * Committed as a *generator* rather than as half a million lines of files: a
 * vendored corpus that size makes every clone slower forever, and a generator
 * can be re-run at a different size when the budget or the hardware changes.
 *
 * **Deterministic.** The same seed produces byte-identical output, so a
 * measurement is comparable between runs and between machines. A corpus that
 * varied would turn every performance regression into an argument about whether
 * the corpus got harder.
 *
 * The shape matters more than the size. A benchmark of 500,000 identical lines
 * measures nothing useful: it would parse at a rate no real repository
 * achieves, and would miss every cost that actually dominates. So this
 * deliberately reproduces the distribution of a real codebase — a long tail of
 * small files with a few large ones, several languages, files with no grammar,
 * files that will not parse, and a large ignored directory that must cost
 * nothing.
 */

export interface CorpusOptions {
  readonly targetLines: number
  /** Same seed, same corpus. */
  readonly seed?: number
}

export interface GeneratedCorpus {
  readonly path: string
  readonly files: number
  readonly lines: number
}

/**
 * A small deterministic PRNG (mulberry32).
 *
 * `Math.random` cannot be seeded, and a benchmark that is not reproducible is a
 * number nobody can act on.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = [
  'widget', 'invoice', 'ledger', 'account', 'session', 'payment', 'order', 'basket',
  'profile', 'address', 'shipment', 'catalogue', 'discount', 'refund', 'audit', 'policy',
]

/**
 * A TypeScript module of roughly `lines` lines.
 *
 * Real code, not filler: it parses, it has symbols at realistic density, and it
 * has imports — so the parse and the symbol walk do the work they would do on a
 * real repository rather than skipping a file of comments.
 */
function typescriptModule(random: () => number, lines: number): string {
  const pick = (): string => WORDS[Math.floor(random() * WORDS.length)]!
  const out: string[] = [
    `import { readFile } from 'node:fs/promises'`,
    `import type { ${pick()} } from './types.js'`,
    ``,
  ]

  // Whole constructs only, and the file ends when the next one would overshoot.
  // Slicing to an exact line count truncates mid-class and produces a file that
  // does not parse — which would be a corpus where most files take the *failure*
  // path, and failures are cheaper than successes. The benchmark would then
  // flatter itself by measuring the work it did not do.
  while (out.length < lines) {
    const name = `${pick()}${Math.floor(random() * 10_000)}`
    const kind = random()

    if (kind < 0.25) {
      out.push(
        `export interface ${name} {`,
        `  id: string`,
        `  ${pick()}: number`,
        `  ${pick()}: boolean`,
        `}`,
        ``,
      )
    } else if (kind < 0.5) {
      out.push(
        `export class ${name} {`,
        `  private readonly items: string[] = []`,
        ``,
        `  add(value: string): void {`,
        `    this.items.push(value)`,
        `  }`,
        ``,
        `  find(value: string): string | undefined {`,
        `    return this.items.find((item) => item === value)`,
        `  }`,
        `}`,
        ``,
      )
    } else {
      out.push(
        `export function ${name}(input: string, count: number): string {`,
        `  const parts: string[] = []`,
        `  for (let index = 0; index < count; index++) {`,
        `    parts.push(\`\${input}-\${index}\`)`,
        `  }`,
        `  return parts.join(', ')`,
        `}`,
        ``,
      )
    }
  }

  return out.join('\n')
}

function pythonModule(random: () => number, lines: number): string {
  const pick = (): string => WORDS[Math.floor(random() * WORDS.length)]!
  const out: string[] = ['import json', 'from typing import Any', '']

  while (out.length < lines) {
    const name = `${pick()}_${Math.floor(random() * 10_000)}`
    out.push(
      `def ${name}(value: str, count: int) -> list[str]:`,
      `    """Return count copies of value."""`,
      `    return [f"{value}-{index}" for index in range(count)]`,
      ``,
    )
  }
  return out.join('\n')
}

function markdownDocument(random: () => number, lines: number): string {
  const pick = (): string => WORDS[Math.floor(random() * WORDS.length)]!
  const out: string[] = [`# ${pick()}`, '']
  while (out.length < lines) {
    out.push(`## ${pick()}`, '', `Notes about the ${pick()} and its ${pick()}.`, '')
  }
  return out.join('\n')
}

/**
 * File sizes, as a distribution rather than a constant.
 *
 * Real repositories are a long tail: mostly small modules, a handful of large
 * ones. A uniform size would hide the cost that actually dominates, which is
 * per-file overhead on the many rather than parse time on the few.
 */
function nextFileLines(random: () => number): number {
  const roll = random()
  if (roll < 0.7) return 40 + Math.floor(random() * 120) // the common case
  if (roll < 0.95) return 200 + Math.floor(random() * 400) // substantial modules
  return 800 + Math.floor(random() * 1_500) // the few big ones
}

export function generateCorpus(root: string, options: CorpusOptions): GeneratedCorpus {
  const random = seeded(options.seed ?? 20260903)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })

  const write = (path: string, text: string): void => {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text, 'utf8')
  }

  write(
    'package.json',
    JSON.stringify(
      { name: 'benchmark', private: true, scripts: { test: 'vitest run' }, dependencies: { next: '^14' } },
      null,
      2,
    ),
  )
  write('pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
  // A large ignored directory. Walking it must cost nothing, and a benchmark
  // that omitted it would flatter a walker that ignores ignore rules.
  write('.gitignore', 'node_modules/\ndist/\n.env\n')
  write('.env', 'SECRET=hunter2\n')

  let lines = 0
  let files = 0
  let index = 0

  while (lines < options.targetLines) {
    const size = nextFileLines(random)
    // Nested, and widening: a flat directory of ten thousand files is not a
    // repository shape, and directory traversal is part of what is measured.
    const depth = 1 + Math.floor(random() * 3)
    const segments = Array.from(
      { length: depth },
      () => `${WORDS[Math.floor(random() * WORDS.length)]!}s`,
    )
    const dir = join('src', ...segments).split('\\').join('/')

    const roll = random()
    if (roll < 0.75) {
      write(`${dir}/module${index}.ts`, typescriptModule(random, size))
    } else if (roll < 0.9) {
      write(`${dir}/service${index}.py`, pythonModule(random, size))
    } else {
      // No grammar: still walked, hashed, chunked and embedded, just without
      // symbols. Real repositories are full of these and they are not free.
      write(`${dir}/notes${index}.md`, markdownDocument(random, size))
    }

    lines += size
    files += 1
    index += 1
  }

  // A handful of files that will not parse. Every real repository has some —
  // generated code, a vendored bundle, syntax newer than the grammar — and
  // AC7's containment costs something that a clean corpus would never show.
  for (let broken = 0; broken < Math.max(1, Math.floor(files * 0.002)); broken++) {
    write(`src/generated/broken${broken}.ts`, `export function ( { [ unterminated ${broken}`)
    files += 1
  }

  // Ignored, and deliberately large: it must not appear in the index and must
  // not appear in the time either.
  for (let vendored = 0; vendored < 200; vendored++) {
    write(`node_modules/pkg${vendored}/index.js`, typescriptModule(random, 200))
  }

  return { path: root, files, lines }
}
