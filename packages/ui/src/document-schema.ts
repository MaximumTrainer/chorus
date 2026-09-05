import { getSchema, Node, mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Mention from '@tiptap/extension-mention'
import Table from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import type { Schema } from 'prosemirror-model'

/**
 * What a Chorus document may contain (DOC-2 AC6).
 *
 * The schema is shared, deliberately and in one place. The editor, the
 * collaboration server's stored state, and every export read the same
 * definition — because a node type the schema does not know is not rejected by
 * ProseMirror, it is *dropped*. The document still opens, still looks like a
 * document, and is quietly missing the table somebody spent an afternoon on.
 * Two definitions of "what a document is" would produce exactly that, at the
 * boundary between them.
 */

/** The Yjs fragment a document's content lives in. One name, used everywhere. */
export const DOCUMENT_FRAGMENT = 'default'

/**
 * An embedded external artefact — a board, a design file, a video.
 *
 * A node rather than a link, because what it points at is *shown*, and because
 * an embed carries a provider: reconstructing which service a URL belongs to at
 * render time means a regular expression per service, updated by whoever
 * notices it broke.
 */
export const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      src: { default: null },
      provider: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-embed]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-embed': '' }, HTMLAttributes)]
  },
})

export const documentExtensions = [
  StarterKit.configure({
    // Provided by the collaboration extension in the editor: two histories over
    // one document undo each other's work.
    history: false,
  }),
  Image,
  Mention,
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  TaskList,
  TaskItem.configure({ nested: true }),
  Embed,
]

export const documentSchema: Schema = getSchema(documentExtensions)

/**
 * Every node type a document may contain.
 *
 * Derived from the schema rather than listed, so a node added to the editor
 * cannot be missing from the round-trip test — a hand-written list is out of
 * date the first time somebody adds an extension, and the test that depends on
 * it then covers less while still passing.
 */
export const SUPPORTED_NODES: readonly string[] = Object.keys(documentSchema.nodes).filter(
  (name) => name !== 'doc' && name !== 'text',
)

interface JsonNode {
  type: string
  attrs?: Record<string, unknown>
  content?: JsonNode[]
  text?: string
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
}

/**
 * A document as Markdown (DOC-2 AC6, DOC-7).
 *
 * Written here rather than taken from `prosemirror-markdown`, which has no
 * serialiser for tables, task lists, mentions or embeds — the four node types
 * most likely to carry the part of a document somebody actually needs. A
 * serialiser that silently omits a node is the same loss as a schema that drops
 * one, arriving later and somewhere else.
 */
export function documentToMarkdown(json: unknown): string {
  const doc = json as JsonNode
  return (doc.content ?? [])
    .map((node) => block(node))
    .filter((chunk) => chunk !== '')
    .join('\n\n')
    .trimEnd()
}

function inline(node: JsonNode): string {
  if (node.type === 'text') {
    let out = node.text ?? ''
    for (const mark of node.marks ?? []) {
      if (mark.type === 'bold') out = `**${out}**`
      if (mark.type === 'italic') out = `*${out}*`
      if (mark.type === 'code') out = `\`${out}\``
      if (mark.type === 'strike') out = `~~${out}~~`
      if (mark.type === 'link') out = `[${out}](${String(mark.attrs?.href ?? '')})`
    }
    return out
  }

  if (node.type === 'mention') {
    // The identity as well as the name. Two people called Ada is not a rare
    // situation, and a mention exported as a name has lost what made it one.
    const { id, label } = node.attrs ?? {}
    return `@${String(label ?? id ?? '')} (${String(id ?? '')})`
  }

  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'image') return image(node)

  return (node.content ?? []).map(inline).join('')
}

const image = (node: JsonNode): string => {
  const { src, alt, title } = node.attrs ?? {}
  const caption = title ? ` "${String(title)}"` : ''
  return `![${String(alt ?? '')}](${String(src ?? '')}${caption})`
}

const text = (node: JsonNode): string => (node.content ?? []).map(inline).join('')

function block(node: JsonNode, depth = 0): string {
  const pad = '  '.repeat(depth)

  switch (node.type) {
    case 'heading':
      return `${'#'.repeat(Number(node.attrs?.level ?? 1))} ${text(node)}`

    case 'paragraph':
      return `${pad}${text(node)}`

    case 'codeBlock':
      // The language is kept: a fenced block without one loses the highlighting
      // and, in a spec, the signal that this is TypeScript rather than pseudocode.
      return `\`\`\`${String(node.attrs?.language ?? '')}\n${text(node)}\n\`\`\``

    case 'blockquote':
      return (node.content ?? [])
        .map((child) => `> ${block(child).replace(/\n/g, '\n> ')}`)
        .join('\n>\n')

    case 'bulletList':
      return (node.content ?? [])
        .map((item) => `${pad}- ${listItemBody(item, depth)}`)
        .join('\n')

    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1)
      return (node.content ?? [])
        .map((item, index) => `${pad}${start + index}. ${listItemBody(item, depth)}`)
        .join('\n')
    }

    case 'taskList':
      return (node.content ?? [])
        .map((item) => `${pad}- [${item.attrs?.checked ? 'x' : ' '}] ${listItemBody(item, depth)}`)
        .join('\n')

    case 'table':
      return table(node)

    case 'image':
      return image(node)

    case 'embed':
      // Rendered as a link rather than omitted. Markdown cannot embed, and a
      // reader who can see the URL can still reach what it points at; a reader
      // given nothing cannot tell there was anything there.
      return `[${String(node.attrs?.provider ?? 'embed')}](${String(node.attrs?.src ?? '')})`

    case 'horizontalRule':
      return '---'

    default:
      return text(node)
  }
}

/** A list item's own content, with any nested list indented beneath it. */
function listItemBody(item: JsonNode, depth: number): string {
  const [first, ...rest] = item.content ?? []
  const head = first ? block(first) : ''
  const nested = rest.map((child) => block(child, depth + 1)).join('\n')
  return nested ? `${head}\n${nested}` : head
}

function table(node: JsonNode): string {
  const rows = (node.content ?? []).map((row) =>
    // A pipe inside a cell would end the cell. Escaped rather than
    // stripped: a table of shell commands is a real thing to write.
    (row.content ?? []).map((cell) => text(cell).split('|').join('\\|')),
  )
  if (rows.length === 0) return ''

  const [header = [], ...body] = rows
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n')
}
