/**
 * Atlassian Document Format ↔ Markdown (INT-8 AC3).
 *
 * Jira stores rich text as ADF, a nested JSON document; Chorus works in
 * Markdown. The two convert at the connector boundary — ADF → Markdown on the
 * way in (normalisation), Markdown → ADF on the way out (the sink). The
 * guarantee is structural: the constructs a team actually uses — headings,
 * paragraphs with bold/italic/code, bullet and ordered lists, fenced code
 * blocks and links — survive a Markdown → ADF → Markdown round trip.
 *
 * A construct this version does not model is not dropped: its text is kept, so
 * a Jira panel or table degrades to its words rather than vanishing. Forward
 * compatibility matters more than fidelity for the long tail, because losing a
 * sentence a person wrote is the one unrecoverable outcome.
 */

export interface AdfMark {
  readonly type: 'strong' | 'em' | 'code' | 'link' | string
  readonly attrs?: Readonly<Record<string, unknown>>
}

export interface AdfNode {
  readonly type: string
  readonly version?: number
  readonly text?: string
  readonly marks?: readonly AdfMark[]
  readonly attrs?: Readonly<Record<string, unknown>>
  readonly content?: readonly AdfNode[]
}

// ─── Markdown → ADF ──────────────────────────────────────────────────────────

/** The href prefix that marks a Markdown link as an encoded Jira mention. */
const MENTION_HREF = 'jira:mention:'

/** Splits a paragraph's text into ADF inline nodes, carrying one mark each. */
function inlineToAdf(text: string): AdfNode[] {
  const nodes: AdfNode[] = []
  // Ordered by how Markdown disambiguates: `**` before `*`, and code spans and
  // links are matched whole so their contents are not re-scanned for marks. A
  // link whose href is a `jira:mention:` uri is a mention, not a plain link.
  const pattern = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push({ type: 'text', text: text.slice(last, match.index) })
    if (match[2] !== undefined) nodes.push({ type: 'text', text: match[2], marks: [{ type: 'strong' }] })
    else if (match[4] !== undefined) nodes.push({ type: 'text', text: match[4], marks: [{ type: 'em' }] })
    else if (match[6] !== undefined) nodes.push({ type: 'text', text: match[6], marks: [{ type: 'code' }] })
    else if (match[8] !== undefined) {
      const linkText = match[8]
      const href = match[9]!
      if (href.startsWith(MENTION_HREF)) {
        nodes.push({ type: 'mention', attrs: { id: href.slice(MENTION_HREF.length), text: linkText } })
      } else {
        nodes.push({ type: 'text', text: linkText, marks: [{ type: 'link', attrs: { href } }] })
      }
    }
    last = pattern.lastIndex
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) })
  return nodes.length > 0 ? nodes : [{ type: 'text', text }]
}

/** The cells of a Markdown table row: `| a | b |` → `['a', 'b']`. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

const TABLE_SEPARATOR = /^\|(\s*:?-+:?\s*\|)+\s*$/
const PANEL_START = /^>\s*\[!(INFO|NOTE|WARNING|SUCCESS|ERROR)\]\s*$/i

export function markdownToAdf(markdown: string): AdfNode {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const content: AdfNode[] = []
  let i = 0

  const paragraphBuffer: string[] = []
  const flushParagraph = (): void => {
    if (paragraphBuffer.length === 0) return
    content.push({ type: 'paragraph', content: inlineToAdf(paragraphBuffer.join(' ')) })
    paragraphBuffer.length = 0
  }

  while (i < lines.length) {
    const line = lines[i]!

    // Fenced code block.
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      flushParagraph()
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!)
        i += 1
      }
      i += 1 // closing fence
      content.push({
        type: 'codeBlock',
        ...(fence[1] ? { attrs: { language: fence[1] } } : {}),
        content: [{ type: 'text', text: body.join('\n') }],
      })
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      content.push({
        type: 'heading',
        attrs: { level: heading[1]!.length },
        content: inlineToAdf(heading[2]!),
      })
      i += 1
      continue
    }

    // Panel: a GitHub-style alert blockquote, `> [!INFO]` then `> `-prefixed body.
    const panel = PANEL_START.exec(line)
    if (panel) {
      flushParagraph()
      const body: string[] = []
      i += 1
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^>\s?/, ''))
        i += 1
      }
      // Blank `>` lines separate paragraphs; a run of non-blank lines is one.
      const paragraphs: AdfNode[] = []
      let buffer: string[] = []
      const flush = (): void => {
        if (buffer.length === 0) return
        paragraphs.push({ type: 'paragraph', content: inlineToAdf(buffer.join(' ')) })
        buffer = []
      }
      for (const bodyLine of body) {
        if (bodyLine.trim() === '') flush()
        else buffer.push(bodyLine)
      }
      flush()
      content.push({ type: 'panel', attrs: { panelType: panel[1]!.toLowerCase() }, content: paragraphs })
      continue
    }

    // Table: a `|`-delimited header row followed by a `| --- |` separator.
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!)) {
      flushParagraph()
      const rows: AdfNode[] = []
      const headerCells = tableCells(line)
      rows.push({
        type: 'tableRow',
        content: headerCells.map((cell) => ({
          type: 'tableHeader',
          content: [{ type: 'paragraph', content: inlineToAdf(cell) }],
        })),
      })
      i += 2 // header + separator
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i]!)) {
        rows.push({
          type: 'tableRow',
          content: tableCells(lines[i]!).map((cell) => ({
            type: 'tableCell',
            content: [{ type: 'paragraph', content: inlineToAdf(cell) }],
          })),
        })
        i += 1
      }
      content.push({ type: 'table', content: rows })
      continue
    }

    if (/^[-*]\s+/.test(line)) {
      flushParagraph()
      const items: AdfNode[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) {
        const itemText = lines[i]!.replace(/^[-*]\s+/, '')
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: inlineToAdf(itemText) }] })
        i += 1
      }
      content.push({ type: 'bulletList', content: items })
      continue
    }

    if (/^\d+\.\s+/.test(line)) {
      flushParagraph()
      const items: AdfNode[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!)) {
        const itemText = lines[i]!.replace(/^\d+\.\s+/, '')
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: inlineToAdf(itemText) }] })
        i += 1
      }
      content.push({ type: 'orderedList', content: items })
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      i += 1
      continue
    }

    paragraphBuffer.push(line)
    i += 1
  }
  flushParagraph()

  return { type: 'doc', version: 1, content }
}

// ─── ADF → Markdown ──────────────────────────────────────────────────────────

/** Wraps a text node's content in the Markdown for its marks. */
function inlineToMarkdown(node: AdfNode): string {
  let text = node.text ?? ''
  for (const mark of node.marks ?? []) {
    if (mark.type === 'strong') text = `**${text}**`
    else if (mark.type === 'em') text = `*${text}*`
    else if (mark.type === 'code') text = `\`${text}\``
    else if (mark.type === 'link') {
      const href = (mark.attrs as { href?: string } | undefined)?.href ?? ''
      text = `[${text}](${href})`
    }
  }
  return text
}

/** The plain text inside a node and its descendants, for degrading the unknown. */
function textOf(node: AdfNode): string {
  if (node.type === 'text') return node.text ?? ''
  return (node.content ?? []).map(textOf).join('')
}

/** One inline child rendered to Markdown: text with marks, or a mention link. */
function inlineChild(child: AdfNode): string {
  if (child.type === 'text') return inlineToMarkdown(child)
  if (child.type === 'mention') {
    const attrs = child.attrs as { id?: string; text?: string } | undefined
    return `[${attrs?.text ?? ''}](${MENTION_HREF}${attrs?.id ?? ''})`
  }
  return textOf(child)
}

function inlineContent(node: AdfNode): string {
  return (node.content ?? []).map(inlineChild).join('')
}

function blockToMarkdown(node: AdfNode): string {
  switch (node.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number((node.attrs as { level?: number })?.level ?? 1)))
      return `${'#'.repeat(level)} ${inlineContent(node)}`
    }
    case 'paragraph':
      return inlineContent(node)
    case 'codeBlock': {
      const language = (node.attrs as { language?: string })?.language ?? ''
      return `\`\`\`${language}\n${textOf(node)}\n\`\`\``
    }
    case 'bulletList':
      return (node.content ?? []).map((item) => `- ${inlineContent(item.content?.[0] ?? item)}`).join('\n')
    case 'orderedList':
      return (node.content ?? [])
        .map((item, index) => `${index + 1}. ${inlineContent(item.content?.[0] ?? item)}`)
        .join('\n')
    case 'table': {
      const rows = node.content ?? []
      const lines: string[] = []
      rows.forEach((row, index) => {
        const cells = (row.content ?? []).map((cell) => inlineContent(cell.content?.[0] ?? cell))
        lines.push(`| ${cells.join(' | ')} |`)
        // GFM needs a header separator under the first row.
        if (index === 0) lines.push(`| ${cells.map(() => '---').join(' | ')} |`)
      })
      return lines.join('\n')
    }
    case 'panel': {
      const type = String((node.attrs as { panelType?: string })?.panelType ?? 'info').toUpperCase()
      const body = (node.content ?? []).map(blockToMarkdown).join('\n\n')
      const quoted = body.split('\n').map((bodyLine) => `> ${bodyLine}`).join('\n')
      return `> [!${type}]\n${quoted}`
    }
    default: {
      // Unknown block: keep its words rather than dropping them.
      const inner = (node.content ?? []).map(blockToMarkdown).join('\n\n')
      return inner !== '' ? inner : textOf(node)
    }
  }
}

export function adfToMarkdown(adf: AdfNode): string {
  return (adf.content ?? []).map(blockToMarkdown).join('\n\n')
}
