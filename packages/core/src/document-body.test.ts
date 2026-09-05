import { describe, it, expect } from 'vitest'
import {
  bodyFromTemplate,
  countText,
  documentToMarkdown,
  replaceText,
  sectionsOf,
  withSection,
  type DocumentBody,
} from './document-body.js'

/**
 * DOC-3 — a suggestion applies exactly once, or not at all.
 *
 * The two refusals are the point. A suggestion whose text is gone is stale, and
 * one whose text appears twice is ambiguous; in both cases applying something
 * is worse than applying nothing, because the person who accepted believed they
 * knew what they were agreeing to.
 */
describe('DOC-3 suggestion application', () => {
  const body = (...paragraphs: string[]): DocumentBody => ({
    type: 'doc',
    content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
  })

  it('DOC-3: text present once is replaced', () => {
    const after = replaceText(body('Finance reconcile by hand.'), 'reconcile', 'reconciles')
    expect(documentToMarkdown(after!)).toBe('Finance reconciles by hand.')
  })

  it('DOC-3: text that is no longer there is refused', () => {
    // The document moved on while the suggestion was pending. This is AC5's
    // whole case, and it has to fail closed.
    expect(replaceText(body('Finance reconciles by hand.'), 'reconcile by', 'x')).toBeUndefined()
  })

  it('DOC-3: text appearing twice is refused, rather than guessing at the first', () => {
    const twice = body('Split the payment.', 'Then split the payment again.')
    expect(countText(twice, 'the payment')).toBe(2)
    expect(replaceText(twice, 'the payment', 'the invoice')).toBeUndefined()

    // Case-sensitive, so the capitalised one is a different run of text and is
    // unambiguous. A case-insensitive match would make "Split" and "split"
    // interchangeable and turn a clear suggestion into an ambiguous one.
    expect(countText(twice, 'Split the payment')).toBe(1)
    expect(replaceText(twice, 'Split the payment', 'Split the invoice')).toBeDefined()
  })

  it('DOC-3: a replacement reaches text inside nested nodes', () => {
    const nested: DocumentBody = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'reconcile by hand' }] },
              ],
            },
          ],
        },
      ],
    }
    expect(documentToMarkdown(replaceText(nested, 'by hand', 'automatically')!)).toContain(
      'reconcile automatically',
    )
  })

  it('DOC-3: an empty needle matches nothing, rather than everything', () => {
    // `indexOf('')` is 0 for every string, so an unguarded implementation
    // counts one match per node and cheerfully "applies" a suggestion.
    expect(countText(body('anything'), '')).toBe(0)
    expect(replaceText(body('anything'), '', 'x')).toBeUndefined()
  })
})

/**
 * DOC-2 — a section is a heading inside the body, and content is read back out
 * from under it.
 */
describe('DOC-2 sections within a body', () => {
  const template = [
    { key: 'problem', title: 'Problem' },
    { key: 'outcome', title: 'Desired outcome' },
  ]

  it('DOC-2: a template lays out headings with nothing written under them', () => {
    expect(sectionsOf(bodyFromTemplate(template))).toEqual({ problem: '', outcome: '' })
  })

  it('DOC-2: writing a section leaves its neighbours alone', () => {
    let body = bodyFromTemplate(template)
    body = withSection(body, { key: 'problem', title: 'Problem', content: 'It costs a day.' })
    body = withSection(body, { key: 'outcome', title: 'Desired outcome', content: 'It costs an hour.' })

    expect(sectionsOf(body)).toEqual({ problem: 'It costs a day.', outcome: 'It costs an hour.' })
  })

  it('DOC-2: rewriting a section replaces what was under it, not what follows', () => {
    let body = bodyFromTemplate(template)
    body = withSection(body, { key: 'problem', title: 'Problem', content: 'First.\n\nSecond.' })
    body = withSection(body, { key: 'outcome', title: 'Desired outcome', content: 'Kept.' })
    body = withSection(body, { key: 'problem', title: 'Problem', content: 'Rewritten.' })

    // Two paragraphs replaced by one, and the next section still intact — the
    // failure here would be a rewrite that ate the following heading.
    expect(sectionsOf(body)).toEqual({ problem: 'Rewritten.', outcome: 'Kept.' })
  })

  it('DOC-2: a section the body has no heading for is added rather than dropped', () => {
    // A template that gained a section after the document was created. Dropping
    // the content loses a paragraph somebody wrote because of a change they
    // never made.
    const body = withSection(bodyFromTemplate(template), {
      key: 'risks',
      title: 'Risks',
      content: 'It might not work.',
    })
    expect(sectionsOf(body).risks).toBe('It might not work.')
  })
})
