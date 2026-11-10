import { adfToMarkdown, markdownToAdf, type AdfNode } from '../jira/adf.js'

/**
 * Confluence page bodies ↔ Markdown (INT-9 AC2/AC3).
 *
 * Bodies are ADF (ADR-0022), so the common constructs reuse the Atlassian ADF
 * converter. The Confluence-specific work is macros, which arrive as `extension`
 * / `bodiedExtension` / `inlineExtension` nodes: these are rewritten into
 * standard ADF before rendering, so an expand keeps its body, a tracker-issue
 * macro becomes a Ticket link, a table-of-contents macro becomes a labelled
 * marker, and an unknown macro becomes a labelled placeholder rather than being
 * silently dropped. Images (`media`) become Markdown image syntax.
 */

const EXTENSION_TYPES = new Set(['extension', 'bodiedExtension', 'inlineExtension'])

function extensionKey(node: AdfNode): string {
  return String((node.attrs as { extensionKey?: string } | undefined)?.extensionKey ?? '').toLowerCase()
}

function macroParam(node: AdfNode, name: string): string | undefined {
  const params = (
    node.attrs as { parameters?: { macroParams?: Record<string, { value?: string }> } } | undefined
  )?.parameters?.macroParams
  return params?.[name]?.value
}

/** A text node linking to a Chorus Ticket by the same id the pull maps it to. */
function ticketLink(issueKey: string): AdfNode {
  return { type: 'text', text: issueKey, marks: [{ type: 'link', attrs: { href: `jira:issue:${issueKey}` } }] }
}

/** The Markdown image for a `media`/`mediaSingle` node, as a paragraph. */
function imageParagraph(node: AdfNode): AdfNode {
  const media = node.type === 'media' ? node : (node.content ?? []).find((c) => c.type === 'media')
  const attrs = media?.attrs as { url?: string; alt?: string; id?: string } | undefined
  const url = attrs?.url ?? attrs?.id ?? ''
  return { type: 'paragraph', content: [{ type: 'text', text: `![${attrs?.alt ?? ''}](${url})` }] }
}

/** Rewrite one macro node into standard ADF. */
function resolveExtension(node: AdfNode): AdfNode {
  const key = extensionKey(node)
  if (key === 'expand') {
    // Keep the body: an unknown block node renders its content by default.
    return { ...node, content: (node.content ?? []).map(resolveNode) }
  }
  if (key === 'toc') {
    return { type: 'paragraph', content: [{ type: 'text', text: '[Table of contents]' }] }
  }
  const issueKey = macroParam(node, 'key')
  if ((key === 'jira' || key === 'jira-issues') && issueKey) {
    return node.type === 'inlineExtension'
      ? ticketLink(issueKey)
      : { type: 'paragraph', content: [ticketLink(issueKey)] }
  }
  // Unknown macro: a labelled placeholder, with any body kept after it.
  const label = `[Unsupported macro: ${key || 'unknown'}]`
  if (node.type === 'inlineExtension') return { type: 'text', text: label }
  const body = (node.content ?? []).map(resolveNode)
  return { ...node, content: [{ type: 'paragraph', content: [{ type: 'text', text: label }] }, ...body] }
}

function resolveNode(node: AdfNode): AdfNode {
  if (node.type === 'media' || node.type === 'mediaSingle' || node.type === 'mediaGroup') {
    return imageParagraph(node)
  }
  if (EXTENSION_TYPES.has(node.type)) return resolveExtension(node)
  if (node.content) return { ...node, content: node.content.map(resolveNode) }
  return node
}

/** Resolve Confluence macros across a whole document. */
function resolveMacros(adf: AdfNode): AdfNode {
  return { ...adf, content: (adf.content ?? []).map(resolveNode) }
}

export function confluenceToMarkdown(adf: AdfNode): string {
  return adfToMarkdown(resolveMacros(adf))
}

export function markdownToConfluence(markdown: string): AdfNode {
  return markdownToAdf(markdown)
}
