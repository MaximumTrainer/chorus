import type { DocumentBody } from './document-body.js'

/**
 * A document as HTML (DOC-7 AC2).
 *
 * The format a word processor reads on paste. Which means the structures have
 * to be the ones it looks for — a real `<table>` with `<th>` and `<td>`, a real
 * `<ul>`, a real `<pre><code>` — because a paste that arrives as styled
 * paragraphs has lost exactly what somebody wanted the table for.
 */

interface JsonNode {
  type: string
  attrs?: Record<string, unknown>
  content?: JsonNode[]
  text?: string
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
}

/**
 * Escapes text for HTML.
 *
 * Applied to every piece of content without exception. A document containing
 * `0.2 < 1 && true` — which any document about software eventually does — would
 * otherwise open a tag the rest of the export then lives inside, and arrive
 * looking like one long code block.
 */
function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Resolves a link or image source against the deployment it came from. */
export function absolute(url: string, baseUrl: string): string {
  if (url === '' || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return url
  if (!url.startsWith('/')) return url
  return `${baseUrl.replace(/\/+$/, '')}${url}`
}

function inline(node: JsonNode, baseUrl: string): string {
  if (node.type === 'text') {
    let out = escape(node.text ?? '')
    for (const mark of node.marks ?? []) {
      if (mark.type === 'bold') out = `<strong>${out}</strong>`
      if (mark.type === 'italic') out = `<em>${out}</em>`
      if (mark.type === 'code') out = `<code>${out}</code>`
      if (mark.type === 'strike') out = `<s>${out}</s>`
      if (mark.type === 'link') {
        out = `<a href="${escape(absolute(String(mark.attrs?.href ?? ''), baseUrl))}">${out}</a>`
      }
    }
    return out
  }

  if (node.type === 'hardBreak') return '<br>'
  if (node.type === 'image') return image(node, baseUrl)
  if (node.type === 'mention') {
    const { id, label } = node.attrs ?? {}
    return `<span data-mention="${escape(String(id ?? ''))}">@${escape(String(label ?? id ?? ''))}</span>`
  }

  return (node.content ?? []).map((child) => inline(child, baseUrl)).join('')
}

const image = (node: JsonNode, baseUrl: string): string => {
  const { src, alt, title } = node.attrs ?? {}
  const caption = title ? ` title="${escape(String(title))}"` : ''
  return `<img src="${escape(absolute(String(src ?? ''), baseUrl))}" alt="${escape(String(alt ?? ''))}"${caption}>`
}

const children = (node: JsonNode, baseUrl: string): string =>
  (node.content ?? []).map((child) => inline(child, baseUrl)).join('')

function block(node: JsonNode, baseUrl: string): string {
  switch (node.type) {
    case 'heading':
      // Offset by one: the document's title is the `<h1>`, so a section that
      // is `##` in Markdown is `<h2>` here and the outline stays a tree.
      return `<h${Number(node.attrs?.level ?? 2)}>${children(node, baseUrl)}</h${Number(node.attrs?.level ?? 2)}>`

    case 'paragraph':
      return `<p>${children(node, baseUrl)}</p>`

    case 'codeBlock': {
      const language = node.attrs?.language
      const attribute = language ? ` class="language-${escape(String(language))}"` : ''
      return `<pre><code${attribute}>${children(node, baseUrl)}</code></pre>`
    }

    case 'blockquote':
      return `<blockquote>${(node.content ?? []).map((child) => block(child, baseUrl)).join('')}</blockquote>`

    case 'bulletList':
      return `<ul>${(node.content ?? []).map((item) => listItem(item, baseUrl)).join('')}</ul>`

    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1)
      const attribute = start === 1 ? '' : ` start="${start}"`
      return `<ol${attribute}>${(node.content ?? []).map((item) => listItem(item, baseUrl)).join('')}</ol>`
    }

    case 'taskList':
      return `<ul data-type="taskList">${(node.content ?? [])
        .map(
          (item) =>
            `<li><input type="checkbox" disabled${item.attrs?.checked ? ' checked' : ''}> ${listBody(item, baseUrl)}</li>`,
        )
        .join('')}</ul>`

    case 'table':
      return `<table>${(node.content ?? []).map((row) => tableRow(row, baseUrl)).join('')}</table>`

    case 'image':
      return image(node, baseUrl)

    case 'embed':
      return `<p><a href="${escape(absolute(String(node.attrs?.src ?? ''), baseUrl))}">${escape(
        String(node.attrs?.provider ?? 'embed'),
      )}</a></p>`

    case 'horizontalRule':
      return '<hr>'

    default:
      return `<p>${children(node, baseUrl)}</p>`
  }
}

const listBody = (item: JsonNode, baseUrl: string): string =>
  (item.content ?? [])
    .map((child) => (child.type === 'paragraph' ? children(child, baseUrl) : block(child, baseUrl)))
    .join('')

const listItem = (item: JsonNode, baseUrl: string): string =>
  `<li>${listBody(item, baseUrl)}</li>`

const tableRow = (row: JsonNode, baseUrl: string): string =>
  `<tr>${(row.content ?? [])
    .map((cell) => {
      const tag = cell.type === 'tableHeader' ? 'th' : 'td'
      const span = Number(cell.attrs?.colspan ?? 1)
      const attribute = span > 1 ? ` colspan="${span}"` : ''
      return `<${tag}${attribute}>${(cell.content ?? [])
        .map((child) => (child.type === 'paragraph' ? children(child, baseUrl) : block(child, baseUrl)))
        .join('')}</${tag}>`
    })
    .join('')}</tr>`

export function documentToHtml(title: string, body: DocumentBody, baseUrl: string): string {
  const rendered = body.content.map((node) => block(node as JsonNode, baseUrl)).join('\n')
  return `<h1>${escape(title)}</h1>\n${rendered}\n`
}
