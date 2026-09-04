import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TEMPLATES,
  DOCUMENT_TYPES,
  TemplateSectionSchema,
  applyTemplate,
  isDocumentType,
  missingSections,
  toMarkdown,
  validateTemplate,
} from './documents.js'

/**
 * DOC-1 — template validation, and the line between guidance and content.
 *
 * The distinction guarded here is the one AC3 names: guidance is advice to the
 * author and must never become part of the document. Every test below is a
 * place where it could leak — into a new document's content, into an export,
 * or into the readiness check that decides whether a section counts as filled.
 */
describe('DOC-1 document templates', () => {
  const sections = [
    { key: 'problem', title: 'Problem', guidance: 'Who has it?', required: true },
    { key: 'notes', title: 'Notes', guidance: 'Anything else.', required: false },
  ]

  it('DOC-1 AC1: applying a template preserves the order it was written in', () => {
    // A document whose sections arrive shuffled is one the author has to
    // reassemble before they can think.
    expect(applyTemplate(sections).map((s) => s.key)).toEqual(['problem', 'notes'])
  })

  it('DOC-1 AC3: a new document starts empty, with guidance beside the content', () => {
    const applied = applyTemplate(sections)

    // Seeding content with the guidance would make an untouched document look
    // written, and every consumer downstream would treat the platform's
    // prompts as the team's words.
    expect(applied.every((s) => s.content === '')).toBe(true)
    expect(applied[0]!.guidance).toBe('Who has it?')
  })

  it('DOC-1 AC3: an export carries headings and content, never guidance', () => {
    const written = applyTemplate(sections).map((section) =>
      section.key === 'notes' ? { ...section, content: 'A real observation.' } : section,
    )
    const markdown = toMarkdown('My document', written)

    expect(markdown).toContain('# My document')
    expect(markdown).toContain('## Problem')
    expect(markdown).toContain('A real observation.')
    // The failure that matters: guidance in an export reads as something the
    // author wrote.
    expect(markdown).not.toContain('Who has it?')
    expect(markdown).not.toContain('Anything else.')
  })

  it('DOC-1 AC3: an empty section leaves a heading and no invented body', () => {
    // A placeholder written into the export would be indistinguishable from
    // content when somebody reads the file later.
    const markdown = toMarkdown('Empty', applyTemplate(sections))
    expect(markdown).toContain('## Problem')
    expect(markdown.replace(/#.*$/gm, '').trim()).toBe('')
  })

  it('DOC-1 AC4: a required section with only whitespace still counts as missing', () => {
    // Otherwise a stray newline would satisfy the check, and the report would
    // say a document is ready when nobody has written anything in it.
    const applied = applyTemplate(sections).map((section) =>
      section.key === 'problem' ? { ...section, content: '   \n  ' } : section,
    )
    expect(missingSections(applied)).toEqual(['problem'])
  })

  it('DOC-1 AC4: an optional section left empty is not reported', () => {
    const applied = applyTemplate(sections).map((section) =>
      section.key === 'problem' ? { ...section, content: 'Written.' } : section,
    )
    expect(missingSections(applied)).toEqual([])
  })

  it('DOC-1: duplicate section keys are refused, because content is addressed by key', () => {
    // Two sections sharing a key makes it ambiguous which a saved paragraph
    // belongs to — and the ambiguity shows up later, as text that moves
    // between sections when the document is reopened.
    const problems = validateTemplate([
      { key: 'problem', title: 'Problem', guidance: '', required: false },
      { key: 'problem', title: 'Also problem', guidance: '', required: false },
    ])
    expect(problems.some((p) => p.message.includes('more than once'))).toBe(true)
  })

  it('DOC-1: a well-formed template has nothing to report', () => {
    // Without this, the check above would pass against a function that always
    // complained.
    expect(validateTemplate(sections)).toEqual([])
  })

  it('DOC-1: a section key is constrained so it can be addressed unambiguously', () => {
    expect(() => TemplateSectionSchema.parse({ key: 'Has Space', title: 'x' })).toThrow()
    expect(() => TemplateSectionSchema.parse({ key: '', title: 'x' })).toThrow()
    expect(TemplateSectionSchema.parse({ key: 'ok_key', title: 'x' }).guidance).toBe('')
  })

  it('DOC-1: every document type ships a template a team could use today', () => {
    // A team should be able to write something on their first day rather than
    // designing five templates first.
    for (const type of DOCUMENT_TYPES) {
      const template = DEFAULT_TEMPLATES[type]
      expect(template.length, `${type} has no sections`).toBeGreaterThan(0)
      expect(validateTemplate(template), `${type} is malformed`).toEqual([])
      // Guidance is the point of a template; a section without it is a heading.
      expect(template.some((s) => s.guidance.length > 0), `${type} offers no guidance`).toBe(true)
    }
  })

  it('DOC-1: a type arriving over the wire is checked, not trusted', () => {
    expect(isDocumentType('prd')).toBe(true)
    expect(isDocumentType('proposal')).toBe(false)
  })
})
