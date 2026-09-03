import { describe, it, expect, beforeAll } from 'vitest'
import { createParser, languageFor, type SourceParser } from './parse.js'

/**
 * BRAIN-2 AC7 — parsing, and containing its failures.
 *
 * A repository contains generated files, vendored code, and syntax newer than
 * whatever grammar we shipped. A parser that took the run down with it would
 * make indexing fail on exactly the repositories worth indexing, so the
 * assertions here are as much about the bad cases as the good ones.
 */
describe('BRAIN-2 source parsing', () => {
  let parser: SourceParser

  beforeAll(async () => {
    parser = await createParser()
  }, 60_000)

  it('BRAIN-2: TypeScript yields symbols with usable line ranges', async () => {
    const source = [
      `import { readFile } from 'node:fs/promises'`,
      ``,
      `export interface Widget {`,
      `  id: string`,
      `}`,
      ``,
      `export function makeWidget(id: string): Widget {`,
      `  return { id }`,
      `}`,
    ].join('\n')

    const parsed = await parser.parse('src/widget.ts', source)

    expect(parsed.failure).toBeUndefined()
    const names = parsed.symbols.map((symbol) => symbol.name)
    expect(names).toContain('Widget')
    expect(names).toContain('makeWidget')

    const fn = parsed.symbols.find((symbol) => symbol.name === 'makeWidget')!
    // The range is what a citation shows, so it has to be the real one.
    expect(fn.lineStart).toBe(7)
    expect(fn.lineEnd).toBe(9)
    expect(fn.kind).toBe('function')
  })

  it('BRAIN-2: imports are collected, because the dependency graph is half the point', async () => {
    const source = [
      `import { readFile } from 'node:fs/promises'`,
      `import Widget from './widget.js'`,
      `export const x = 1`,
    ].join('\n')

    const parsed = await parser.parse('src/main.ts', source)
    expect(parsed.imports).toEqual(expect.arrayContaining(['node:fs/promises', './widget.js']))
  })

  it('BRAIN-2: a class is one symbol, and its methods are reported too', async () => {
    // Both are wanted: chunking drops the nested ones, but a symbol index that
    // could not answer "where is `add` defined" would be half a symbol index.
    const source = [
      `export class WidgetStore {`,
      `  add(w: Widget) {}`,
      `  remove(id: string) {}`,
      `}`,
    ].join('\n')

    const parsed = await parser.parse('src/store.ts', source)
    const names = parsed.symbols.map((symbol) => symbol.name)
    expect(names).toContain('WidgetStore')
    expect(names).toContain('add')
  })

  it('BRAIN-2 AC7: a file that will not parse is reported, not thrown', async () => {
    const parsed = await parser.parse('src/broken.ts', 'export function ( { [ unterminated')

    // The run continues. A recorded reason is what makes the gap visible later,
    // rather than a file that is silently absent from the index.
    expect(parsed.symbols).toEqual([])
    expect(parsed.failure).toBeTruthy()
  })

  it('BRAIN-2 AC7: an unsupported language yields no symbols and no failure', async () => {
    // These are different states: "we have no grammar" is expected and fine,
    // "this file is broken" is worth recording. Conflating them would fill the
    // failure log with every .txt in the repository.
    const parsed = await parser.parse('README.md', '# Hello\n\nSome prose.')

    expect(parsed.symbols).toEqual([])
    expect(parsed.failure).toBeUndefined()
    expect(languageFor('README.md')).toBeUndefined()
  })

  it('BRAIN-2: language is chosen by extension, including the tsx and js cases', () => {
    expect(languageFor('src/a.ts')).toBe('typescript')
    // .tsx needs its own grammar: the TypeScript grammar cannot parse JSX, and
    // using it would make every React component a parse failure.
    expect(languageFor('src/a.tsx')).toBe('tsx')
    expect(languageFor('src/a.js')).toBe('javascript')
    expect(languageFor('src/a.jsx')).toBe('javascript')
    expect(languageFor('src/a.py')).toBe('python')
    expect(languageFor('src/a.go')).toBe('go')
    expect(languageFor('src/a.rs')).toBe('rust')
    expect(languageFor('LICENSE')).toBeUndefined()
  })

  it('BRAIN-2: a React component in a .tsx file parses', async () => {
    const source = [
      `export function Button({ label }: { label: string }) {`,
      `  return <button>{label}</button>`,
      `}`,
    ].join('\n')

    const parsed = await parser.parse('src/Button.tsx', source)
    expect(parsed.failure).toBeUndefined()
    expect(parsed.symbols.map((symbol) => symbol.name)).toContain('Button')
  })

  it('BRAIN-2: Python yields symbols too, so support is not TypeScript-shaped', async () => {
    const source = ['def make_widget(id):', '    return {"id": id}', '', 'class Store:', '    pass'].join(
      '\n',
    )

    const parsed = await parser.parse('src/widget.py', source)
    expect(parsed.symbols.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(['make_widget', 'Store']),
    )
  })

  it('BRAIN-2: an enormous file is refused rather than parsed', async () => {
    // Minified bundles and generated data files are megabytes on one line. They
    // exhaust the parser for no benefit, and their symbols would be noise.
    const parsed = await parser.parse('dist/bundle.js', `const a = ${'"x",'.repeat(500_000)}`)

    expect(parsed.symbols).toEqual([])
    expect(parsed.failure).toMatch(/too large/i)
  })

  it('BRAIN-2: parsing the same source twice gives the same symbols', async () => {
    const source = 'export function alpha() {}\nexport function beta() {}'
    const first = await parser.parse('src/a.ts', source)
    const second = await parser.parse('src/a.ts', source)

    // Re-indexing an unchanged file must be a no-op, which it cannot be if the
    // parse wanders.
    expect(second.symbols).toEqual(first.symbols)
  })
})
