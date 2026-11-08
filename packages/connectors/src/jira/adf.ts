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

/** Splits a paragraph's text into ADF text nodes, carrying one inline mark each. */
function inlineToAdf(text: string): AdfNode[] {
  const nodes: AdfNode[] = []
  // Ordered by how Markdown disambiguates: `**` before `*`, and code spans and
  // links are matched whole so their contents are not re-scanned for marks.
  const pattern = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push({ type: 'text', text: text.slice(last, match.index) })
    if (match[2] !== undefined) nodes.push({ type: 'text', text: match[2], marks: [{ type: 'strong' }] })
    else if (match[4] !== undefined) nodes.push({ type: 'text', text: match[4], marks: [{ type: 'em' }] })
    else if (match[6] !== undefined) nodes.push({ type: 'text', text: match[6], marks: [{ type: 'code' }] })
    else if (match[8] !== undefined)
      nodes.push({ type: 'text', text: match[8], marks: [{ type: 'link', attrs: { href: match[9] } }] })
    last = pattern.lastIndex
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) })
  return nodes.length > 0 ? nodes : [{ type: 'text', text }]
}

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

function inlineContent(node: AdfNode): string {
  return (node.content ?? []).map((child) => (child.type === 'text' ? inlineToMarkdown(child) : textOf(child))).join('')
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
