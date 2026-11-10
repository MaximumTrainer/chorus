import { describe, it, expect } from 'vitest'
import type { AdfNode } from '../jira/adf.js'
import { confluenceToMarkdown, markdownToConfluence } from './body.js'

/**
 * INT-9 AC2/AC3 — Confluence bodies (ADF) convert to Markdown, macros resolved.
 *
 * Bodies are ADF (ADR-0022), so the common constructs reuse the Atlassian ADF
 * converter; the Confluence-specific work is macros. An expand keeps its body, a
 * tracker-issue macro becomes a Ticket link, a table-of-contents macro becomes a
 * labelled marker, and an unknown macro is preserved as a labelled placeholder —
 * never silently dropped, which is the most common failure of this integration.
 */

const doc = (content: AdfNode[]): AdfNode => ({ type: 'doc', version: 1, content })

describe('INT-9 Confluence body conversion', () => {
  it('INT-9 AC3: an expand macro keeps its body', () => {
    const adf = doc([
      {
        type: 'bodiedExtension',
        attrs: { extensionKey: 'expand', extensionType: 'com.atlassian.confluence.macro.core' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hidden but kept.' }] }],
      },
    ])
    expect(confluenceToMarkdown(adf)).toContain('Hidden but kept.')
  })

  it('INT-9 AC3: a tracker-issue macro becomes a Ticket link', () => {
    const adf = doc([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'See ' },
          {
            type: 'inlineExtension',
            attrs: {
              extensionKey: 'jira',
              extensionType: 'com.atlassian.confluence.macro.core',
              parameters: { macroParams: { key: { value: 'ACME-1' } } },
            },
          },
          { type: 'text', text: ' for details.' },
        ],
      },
    ])
    expect(confluenceToMarkdown(adf)).toContain('[ACME-1](jira:issue:ACME-1)')
  })

  it('INT-9 AC3: a table-of-contents macro becomes a labelled marker', () => {
    const adf = doc([{ type: 'extension', attrs: { extensionKey: 'toc' } }])
    expect(confluenceToMarkdown(adf)).toContain('[Table of contents]')
  })

  it('INT-9 AC3: an unknown macro is preserved as a labelled placeholder, not dropped', () => {
    const adf = doc([
      {
        type: 'bodiedExtension',
        attrs: { extensionKey: 'chart' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'raw chart data' }] }],
      },
    ])
    const md = confluenceToMarkdown(adf)
    expect(md).toContain('[Unsupported macro: chart]')
    expect(md).toContain('raw chart data')
  })

  it('INT-9 AC2: an image converts to Markdown image syntax', () => {
    const adf = doc([
      {
        type: 'mediaSingle',
        content: [{ type: 'media', attrs: { type: 'external', url: 'https://img.test/a.png', alt: 'a diagram' } }],
      },
    ])
    expect(confluenceToMarkdown(adf)).toContain('![a diagram](https://img.test/a.png)')
  })

  it('INT-9 AC2: headings, lists and links in a Confluence body read as Markdown', () => {
    const adf = doc([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Runbook' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Open ' },
          { type: 'text', text: 'the dashboard', marks: [{ type: 'link', attrs: { href: 'https://x.test' } }] },
          { type: 'text', text: '.' },
        ],
      },
    ])
    expect(confluenceToMarkdown(adf)).toBe('## Runbook\n\nOpen [the dashboard](https://x.test).')
  })

  it('INT-9 AC2: Markdown converts back to an ADF document for the sink', () => {
    const adf = markdownToConfluence('# Title\n\nA paragraph.')
    expect(adf.type).toBe('doc')
    expect(adf.content?.[0]).toMatchObject({ type: 'heading' })
  })
})
