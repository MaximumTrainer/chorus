/**
 * A document as Markdown, and the shape a document's body has (DOC-7 AC1).
 *
 * In `core` rather than beside the editor because four things need it and only
 * one of them is a browser: the export endpoint, the wiki compiler (BRAIN-5),
 * the MCP resources (MCP-4), and the editor. Written once, per DOC-7's own
 * implementation note.
 *
 * Pure over the document's JSON: no ProseMirror, no Tiptap, no DOM. That is
 * what lets the API render an export without carrying an editor.
 */

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

/** A document's body, as the editor's JSON. Exported for the few callers that build one. */
export interface DocumentBody {
  readonly type: 'doc'
  readonly content: JsonNode[]
}

/**
 * The heading a section is written under.
 *
 * A section is a heading in the body, not a container around it. That is what
 * makes the body one editable surface: a person can write across a section
 * boundary, move a paragraph between two, or delete a heading they do not want
 * — none of which is expressible if each section is its own box.
 *
 * The key travels on the heading's attributes so a section can still be
 * addressed by name after somebody has renamed its title.
 */
export function sectionHeading(key: string, title: string): JsonNode {
  return {
    type: 'heading',
    attrs: { level: 2, sectionKey: key },
    content: [{ type: 'text', text: title }],
  }
}

/**
 * An empty body laid out from a template.
 *
 * Guidance is deliberately *not* written into the body as placeholder text. A
 * document that arrives pre-filled with "Who has this problem?" is one where
 * the guidance has to be deleted before anything can be written, and the
 * version somebody forgets to delete ships as if it were content.
 */
export function bodyFromTemplate(
  sections: ReadonlyArray<{ key: string; title: string }>,
): DocumentBody {
  return {
    type: 'doc',
    content: sections.flatMap((section) => [
      sectionHeading(section.key, section.title),
      { type: 'paragraph' },
    ]),
  }
}

/**
 * Replaces what is written under one section heading.
 *
 * Everything between this heading and the next heading at the same level is the
 * section's content, which is the same rule a reader applies looking at the
 * page. A section whose heading is not there is added at the end rather than
 * dropped: the alternative loses a paragraph somebody wrote because a template
 * changed underneath them.
 */
export function withSection(
  body: DocumentBody,
  section: { key: string; title: string; content: string },
): DocumentBody {
  const paragraphs: JsonNode[] = section.content
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => ({ type: 'paragraph', content: [{ type: 'text', text: block }] }))

  const at = body.content.findIndex(
    (node) => node.type === 'heading' && node.attrs?.sectionKey === section.key,
  )

  if (at === -1) {
    return {
      type: 'doc',
      content: [...body.content, sectionHeading(section.key, section.title), ...paragraphs],
    }
  }

  let end = at + 1
  while (end < body.content.length && body.content[end]!.type !== 'heading') end += 1

  return {
    type: 'doc',
    content: [
      ...body.content.slice(0, at + 1),
      ...(paragraphs.length > 0 ? paragraphs : [{ type: 'paragraph' }]),
      ...body.content.slice(end),
    ],
  }
}

/** What is written under each section heading, as plain text. */
export function sectionsOf(body: DocumentBody): Record<string, string> {
  const found: Record<string, string> = {}
  let current: string | undefined

  for (const node of body.content) {
    if (node.type === 'heading') {
      const key = node.attrs?.sectionKey
      current = typeof key === 'string' ? key : undefined
      if (current) found[current] ??= ''
      continue
    }
    if (!current) continue
    const text = documentToMarkdown({ type: 'doc', content: [node] })
    found[current] = `${found[current] ?? ''}${found[current] ? '\n\n' : ''}${text}`.trim()
  }

  return found
}
