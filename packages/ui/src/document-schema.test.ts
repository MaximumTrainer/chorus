import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror'
import { documentToMarkdown } from '@chorus/core'
import { DOCUMENT_FRAGMENT, documentSchema, SUPPORTED_NODES } from './document-schema.js'

/**
 * DOC-2 AC6 — every node type round-trips.
 *
 * > **Given** a document containing every supported node type
 * > **When** it is saved, reloaded and exported
 * > **Then** every node survives intact.
 *
 * The failure this guards against is quiet. A node the schema does not know
 * about is not rejected by ProseMirror — it is *dropped*, and the document
 * still opens, still looks like a document, and is simply missing the table
 * somebody spent an afternoon on. Nobody gets an error; they get a gap they
 * may not notice until they need what was in it.
 *
 * "Saved and reloaded" here is the real path: the same Yjs encoding the
 * collaboration server writes into `documents.ydoc`, decoded again. A test that
 * round-tripped the ProseMirror JSON alone would prove nothing about the
 * column the document actually lives in.
 */
describe('DOC-2 document schema', () => {
  /** One of everything the requirement lists. */
  const everything = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Invoice splitting' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Finance reconciles by hand.' },
          { type: 'hardBreak' },
          { type: 'text', text: 'Every week.' },
        ],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A bullet' }] }],
          },
        ],
      },
      {
        type: 'orderedList',
        attrs: { start: 1 },
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A step' }] }],
          },
        ],
      },
      {
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: true },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Done already' }] }],
          },
        ],
      },
      {
        type: 'codeBlock',
        attrs: { language: 'ts' },
        content: [{ type: 'text', text: 'export function parseInvoice() {}' }],
      },
      {
        type: 'blockquote',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A quotation' }] }],
      },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableHeader',
                attrs: { colspan: 1, rowspan: 1 },
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Header' }] }],
              },
            ],
          },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                attrs: { colspan: 1, rowspan: 1 },
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cell' }] }],
              },
            ],
          },
        ],
      },
      { type: 'image', attrs: { src: 'https://example.test/a.png', alt: 'A diagram' } },
      { type: 'embed', attrs: { src: 'https://example.test/board/1', provider: 'whiteboard' } },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Asking ' },
          // `mentionSuggestionChar` is the schema's own attribute, written out
          // as the editor would. Spelled here rather than trimmed from the
          // comparison, so a change to what a mention carries is a test failure
          // somebody reads rather than a difference nothing mentions.
          { type: 'mention', attrs: { id: 'user-1', label: 'Ada', mentionSuggestionChar: '@' } },
          { type: 'text', text: ' about it.' },
        ],
      },
      { type: 'horizontalRule' },
    ],
  }

  const save = (json: unknown): Uint8Array =>
    Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(documentSchema, json, DOCUMENT_FRAGMENT))

  const reload = (state: Uint8Array): unknown => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, state)
    return yDocToProsemirrorJSON(doc, DOCUMENT_FRAGMENT)
  }

  it('DOC-2 AC6: the fixture actually contains every supported node type', () => {
    // Without this, a node quietly removed from the fixture would make every
    // assertion below pass while covering less — the way coverage rots.
    const present = new Set<string>()
    const walk = (node: { type: string; content?: unknown[] }): void => {
      present.add(node.type)
      for (const child of node.content ?? []) walk(child as { type: string; content?: unknown[] })
    }
    walk(everything as { type: string; content?: unknown[] })

    expect([...SUPPORTED_NODES].sort().filter((name) => !present.has(name))).toEqual([])
  })

  it('DOC-2 AC6: every node survives being saved and reloaded', () => {
    const reloaded = reload(save(everything))

    // Compared whole rather than node by node. A node type dropped by the
    // schema is not an error in ProseMirror — the document still opens and is
    // simply missing the table somebody spent an afternoon on.
    expect(reloaded).toEqual(everything)
  })

  it('DOC-2 AC6: a node the schema does not know is refused, not silently dropped', () => {
    const smuggled = {
      type: 'doc',
      content: [{ type: 'unknownWidget', attrs: { payload: 'anything' } }],
    }

    // The whole reason the test above is written as an equality: this is what
    // happens to anything the schema has not been taught, and it happens
    // without complaint unless something insists otherwise.
    expect(() => save(smuggled)).toThrow(/unknownWidget/i)
  })

  it('DOC-2 AC6: an export carries every node type through to Markdown', () => {
    const markdown = documentToMarkdown(everything)

    // Export is where the document leaves for a tracker, a prompt or a
    // reviewer's inbox. A node that survives storage and vanishes here is the
    // same loss arriving later.
    expect(markdown).toContain('# Invoice splitting')
    expect(markdown).toContain('- A bullet')
    expect(markdown).toContain('1. A step')
    expect(markdown).toContain('- [x] Done already')
    expect(markdown).toContain('```ts')
    expect(markdown).toContain('> A quotation')
    expect(markdown).toContain('| Header |')
    expect(markdown).toContain('| Cell |')
    expect(markdown).toContain('![A diagram](https://example.test/a.png)')
    expect(markdown).toContain('https://example.test/board/1')
    expect(markdown).toContain('@Ada')
    expect(markdown).toContain('---')
  })

  it('DOC-2 AC6: an exported mention keeps the identity, not only the name', () => {
    // Two people called Ada is not a rare situation, and a mention that
    // exports as a name has lost the thing that made it a mention.
    expect(documentToMarkdown(everything)).toContain('user-1')
  })
})
