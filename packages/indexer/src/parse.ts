import { createRequire } from 'node:module'
import treeSitter from '@vscode/tree-sitter-wasm'

/**
 * Symbol and import extraction (BRAIN-2, architecture.md §10.2).
 *
 * tree-sitter as prebuilt WASM (ADR-0013), so an install needs no compiler and
 * a clean host still boots.
 *
 * The contract that matters is **failure isolation** (AC7): a file that will not
 * parse is reported with a reason and the run continues. A repository contains
 * generated files, vendored code and syntax newer than whatever grammar we
 * shipped, so a parser that took the whole run down with it would fail on
 * exactly the repositories worth indexing.
 *
 * A parse *failure* and an *unsupported language* are deliberately different
 * states. The first is worth recording; the second is expected, and conflating
 * them would fill the failure log with every `.txt` in the repository.
 */

export interface ParsedSymbol {
  readonly kind: string
  readonly name: string
  /** 1-based, inclusive, matching how a citation is written. */
  readonly lineStart: number
  readonly lineEnd: number
  readonly signature: string | null
}

export interface ParsedFile {
  readonly symbols: readonly ParsedSymbol[]
  readonly imports: readonly string[]
  /** Absent on success *and* when no grammar applies. Present only on failure. */
  readonly failure?: string
}

export interface SourceParser {
  parse(path: string, source: string): Promise<ParsedFile>
}

/**
 * Extension to grammar.
 *
 * `.tsx` needs its own grammar: the TypeScript one cannot parse JSX, so sharing
 * it would make every React component a parse failure — a whole category of the
 * most-asked-about files silently missing from the symbol index.
 */
const LANGUAGES: Readonly<Record<string, string>> = Object.freeze({
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  java: 'java',
  cs: 'c-sharp',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  c: 'cpp',
  h: 'cpp',
  php: 'php',
  css: 'css',
  sh: 'bash',
  bash: 'bash',
})

export function languageFor(path: string): string | undefined {
  const extension = path.split('.').pop()?.toLowerCase()
  return extension && extension !== path.toLowerCase() ? LANGUAGES[extension] : undefined
}

/**
 * Node types that name something worth indexing, across grammars.
 *
 * Keyed by node type rather than per language because the grammars agree on
 * most of these names, and a per-language table would be six copies of the same
 * list drifting apart.
 */
const SYMBOL_KINDS: Readonly<Record<string, string>> = Object.freeze({
  function_declaration: 'function',
  function_definition: 'function',
  generator_function_declaration: 'function',
  method_definition: 'method',
  method_declaration: 'method',
  class_declaration: 'class',
  class_definition: 'class',
  class_specifier: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  struct_item: 'struct',
  enum_item: 'enum',
  trait_item: 'trait',
  impl_item: 'impl',
  function_item: 'function',
  type_declaration: 'type',
  module: 'module',
})

const IMPORT_NODES = new Set([
  'import_statement',
  'import_from_statement',
  'import_declaration',
  'use_declaration',
  'require_call',
])

/**
 * A megabyte.
 *
 * Minified bundles and generated data files are megabytes on a single line.
 * They exhaust the parser for no benefit — their symbols would be noise, and
 * their chunks would be an average of everything.
 */
const MAX_SOURCE_BYTES = 1024 * 1024

interface TreeNode {
  readonly type: string
  readonly text: string
  readonly childCount: number
  readonly startPosition: { row: number }
  readonly endPosition: { row: number }
  readonly hasError?: boolean
  child(index: number): TreeNode | null
  childForFieldName(name: string): TreeNode | null
}

export async function createParser(): Promise<SourceParser> {
  const require = createRequire(import.meta.url)
  const { Parser, Language } = treeSitter as unknown as {
    Parser: { init(): Promise<void>; new (): { setLanguage(l: unknown): void; parse(s: string): { rootNode: TreeNode } | null } }
    Language: { load(path: string): Promise<unknown> }
  }

  await Parser.init()

  // Grammars are loaded once and reused. Loading per file dominates the run on
  // any repository large enough for indexing time to matter.
  const loaded = new Map<string, unknown>()
  async function grammar(language: string): Promise<unknown | undefined> {
    const cached = loaded.get(language)
    if (cached) return cached
    try {
      const wasm = require.resolve(`@vscode/tree-sitter-wasm/wasm/tree-sitter-${language}.wasm`)
      const value = await Language.load(wasm)
      loaded.set(language, value)
      return value
    } catch {
      // A grammar the bundle does not ship is an unsupported language, not a
      // failure: the file is still indexed and chunked, just without structure.
      return undefined
    }
  }

  function collect(root: TreeNode): { symbols: ParsedSymbol[]; imports: string[] } {
    const symbols: ParsedSymbol[] = []
    const imports: string[] = []

    const visit = (node: TreeNode): void => {
      const kind = SYMBOL_KINDS[node.type]
      if (kind) {
        const nameNode = node.childForFieldName('name')
        const name = nameNode?.text
        if (name) {
          symbols.push({
            kind,
            name,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            // The first line, which is the signature in every grammar here.
            signature: node.text.split('\n')[0]?.trim().slice(0, 300) ?? null,
          })
        }
      }

      if (IMPORT_NODES.has(node.type)) {
        // The quoted module specifier, whichever child holds it. Matching on the
        // string node rather than a per-grammar field keeps this one rule.
        const match = /['"]([^'"]+)['"]/.exec(node.text)
        if (match?.[1]) imports.push(match[1])
      }

      for (let index = 0; index < node.childCount; index++) {
        const child = node.child(index)
        if (child) visit(child)
      }
    }

    visit(root)
    return { symbols, imports }
  }

  return {
    async parse(path, source) {
      if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
        return { symbols: [], imports: [], failure: 'file too large to parse' }
      }

      const language = languageFor(path)
      if (!language) return { symbols: [], imports: [] }

      const grammarFor = await grammar(language)
      if (!grammarFor) return { symbols: [], imports: [] }

      try {
        const parser = new Parser()
        parser.setLanguage(grammarFor)
        const tree = parser.parse(source)
        if (!tree) return { symbols: [], imports: [], failure: 'the parser returned no tree' }

        // tree-sitter is error-tolerant: it returns a tree with ERROR nodes
        // rather than throwing. Indexing the fragments it salvaged would put
        // half-parsed symbols into the index and citations pointing at them, so
        // a tree containing errors is treated as a failure.
        if (tree.rootNode.hasError) {
          return { symbols: [], imports: [], failure: `${language} parse produced errors` }
        }

        const { symbols, imports } = collect(tree.rootNode)
        return { symbols, imports }
      } catch (error) {
        // Reported, never thrown: one bad file must not end a run.
        return {
          symbols: [],
          imports: [],
          failure: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}
