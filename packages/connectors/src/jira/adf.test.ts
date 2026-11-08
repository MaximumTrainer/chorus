import { describe, it, expect } from 'vitest'
import { adfToMarkdown, markdownToAdf, type AdfNode } from './adf.js'

/**
 * INT-8 AC3 — ADF conversion round-trips.
 *
 * Jira stores rich text as the Atlassian Document Format; Chorus works in
 * Markdown. The two must round-trip for the constructs a team actually uses, so
 * pushing an edited description back does not quietly drop a heading or flatten
 * a list. The guarantee is structural, not byte-exact: Markdown → ADF → Markdown
 * preserves the meaning a reader depends on.
 */
describe('INT-8 ADF conversion', () => {
  const roundTrip = (markdown: string): string => adfToMarkdown(markdownToAdf(markdown))

  it('INT-8 AC3: headings survive the round trip', () => {
    const md = '# Title\n\n## Section\n\n### Detail'
    expect(roundTrip(md)).toBe(md)
  })

  it('INT-8 AC3: paragraphs and inline marks survive', () => {
    const md = 'A paragraph with **bold**, *italic* and `code`.'
    expect(roundTrip(md)).toBe(md)
  })

  it('INT-8 AC3: bullet and ordered lists survive', () => {
    expect(roundTrip('- one\n- two\n- three')).toBe('- one\n- two\n- three')
    expect(roundTrip('1. first\n2. second')).toBe('1. first\n2. second')
  })

  it('INT-8 AC3: fenced code blocks survive, language included', () => {
    const md = '```ts\nconst x = 1\n```'
    expect(roundTrip(md)).toBe(md)
  })

  it('INT-8 AC3: links survive', () => {
    const md = 'See [the docs](https://example.test/docs).'
    expect(roundTrip(md)).toBe(md)
  })

  it('INT-8 AC3: a whole document of mixed constructs round-trips', () => {
    const md = [
      '# Release notes',
      '',
      'The **billing** service now [supports](https://x.test) refunds.',
      '',
      '## Changes',
      '',
      '- faster `checkout`',
      '- fewer errors',
      '',
      '```sql',
      'SELECT 1',
      '```',
    ].join('\n')
    expect(roundTrip(md)).toBe(md)
  })

  it('INT-8 AC3: ADF from Jira converts to readable Markdown', () => {
    // A document shaped like Jira's own output, not one we produced.
    const adf: AdfNode = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Summary' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Deploy ' },
            { type: 'text', text: 'times out', marks: [{ type: 'strong' }] },
            { type: 'text', text: '.' },
          ],
        },
      ],
    }
    expect(adfToMarkdown(adf)).toBe('## Summary\n\nDeploy **times out**.')
  })

  it('INT-8 AC3: an unknown node degrades to its text rather than vanishing', () => {
    // Forward-compatibility: a construct this version does not model must not
    // silently drop the words a person wrote inside it.
    const adf: AdfNode = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'panel',
          attrs: { panelType: 'info' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Heads up.' }] }],
        },
      ],
    }
    expect(adfToMarkdown(adf)).toContain('Heads up.')
  })
})
