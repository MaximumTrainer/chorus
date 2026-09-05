import { Buffer } from 'node:buffer'
import * as Y from 'yjs'
import { prosemirrorJSONToYDoc, updateYFragment, yDocToProsemirrorJSON } from 'y-prosemirror'
import { DOCUMENT_FRAGMENT, documentSchema } from './document-schema.js'
import type { DocumentBody } from '@chorus/core'

/**
 * Reading and writing a document's body (DOC-2, DOC-7).
 *
 * Beside the schema rather than in the API, because encoding a body needs the
 * schema and both have to agree on which copy of ProseMirror they are using. A
 * second resolution of `prosemirror-model` fails at runtime with a message
 * about fragments that says nothing at all about the cause.
 *
 * The body is the CRDT, and only the CRDT. The template's sections describe
 * what headings a document should have; what is written under them lives here,
 * so "what does this document say" has exactly one answer — the one the editor
 * shows, the one the export returns, and the one a prompt is given.
 */

/** The body as the editor's JSON. An absent or empty `ydoc` is an empty document. */
export function decodeBody(stored: Buffer | null | undefined): DocumentBody {
  const doc = new Y.Doc()
  if (stored && stored.length > 0) Y.applyUpdate(doc, new Uint8Array(stored))
  return yDocToProsemirrorJSON(doc, DOCUMENT_FRAGMENT) as DocumentBody
}

/** A brand new body. Only for a document that does not exist yet. */
export function encodeBody(body: DocumentBody): Buffer {
  return Buffer.from(
    Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(documentSchema, body, DOCUMENT_FRAGMENT)),
  )
}

/**
 * Rewrites an existing body, preserving the document's identity.
 *
 * Diffed into the existing fragment rather than replaced with a freshly encoded
 * one. A replacement is a different CRDT: merged with what an open editor
 * holds, it does not overwrite — it *duplicates*, and the document quietly ends
 * up saying everything twice. Diffing produces the same change a person typing
 * would have produced, which merges the way everything else does.
 */
export function rewriteBody(stored: Buffer | null | undefined, body: DocumentBody): Buffer {
  const doc = new Y.Doc()
  if (stored && stored.length > 0) Y.applyUpdate(doc, new Uint8Array(stored))

  const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT)
  const node = documentSchema.nodeFromJSON(body)

  doc.transact(() => {
    updateYFragment(doc, fragment, node, new Map())
  })

  return Buffer.from(Y.encodeStateAsUpdate(doc))
}
