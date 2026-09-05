import { getSchema, Node, mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Heading from '@tiptap/extension-heading'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Mention from '@tiptap/extension-mention'
import Table from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import type { Schema } from 'prosemirror-model'

/**
 * What a Chorus document may contain (DOC-2 AC6).
 *
 * The schema is shared, deliberately and in one place. The editor, the
 * collaboration server's stored state, and every export read the same
 * definition — because a node type the schema does not know is not rejected by
 * ProseMirror, it is *dropped*. The document still opens, still looks like a
 * document, and is quietly missing the table somebody spent an afternoon on.
 * Two definitions of "what a document is" would produce exactly that, at the
 * boundary between them.
 */

/** The Yjs fragment a document's content lives in. One name, used everywhere. */
export const DOCUMENT_FRAGMENT = 'default'

/**
 * An embedded external artefact — a board, a design file, a video.
 *
 * A node rather than a link, because what it points at is *shown*, and because
 * an embed carries a provider: reconstructing which service a URL belongs to at
 * render time means a regular expression per service, updated by whoever
 * notices it broke.
 */
export const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      src: { default: null },
      provider: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-embed]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-embed': '' }, HTMLAttributes)]
  },
})

/**
 * A heading that can carry the key of the template section it opens.
 *
 * A section is a heading in the body rather than a container around it, which
 * is what keeps the body one editable surface: somebody can write across a
 * section boundary, move a paragraph between two, or delete a heading they did
 * not want. The key rides on the heading so a section is still addressable
 * after its title has been rewritten — a person renaming "Problem" to "The
 * problem" has not created a different section.
 */
const SectionHeading = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      sectionKey: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-section-key'),
        renderHTML: (attributes) =>
          attributes.sectionKey ? { 'data-section-key': attributes.sectionKey } : {},
      },
    }
  },
})

export const documentExtensions = [
  StarterKit.configure({
    // Provided by the collaboration extension in the editor: two histories over
    // one document undo each other's work.
    history: false,
    // Replaced below, with the section key it has to carry.
    heading: false,
  }),
  SectionHeading,
  Image,
  // Links are their own extension in Tiptap 2, and a document model without
  // them cannot express a reference to a task or another document — which
  // DOC-7 has to resolve to an absolute URL on the way out.
  Link.configure({ openOnClick: false, autolink: false }),
  Mention,
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  TaskList,
  TaskItem.configure({ nested: true }),
  Embed,
]

export const documentSchema: Schema = getSchema(documentExtensions)

/**
 * Every node type a document may contain.
 *
 * Derived from the schema rather than listed, so a node added to the editor
 * cannot be missing from the round-trip test — a hand-written list is out of
 * date the first time somebody adds an extension, and the test that depends on
 * it then covers less while still passing.
 */
export const SUPPORTED_NODES: readonly string[] = Object.keys(documentSchema.nodes).filter(
  (name) => name !== 'doc' && name !== 'text',
)
