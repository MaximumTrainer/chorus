'use client'

import { useEffect, useMemo, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCursor from '@tiptap/extension-collaboration-cursor'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { DOCUMENT_FRAGMENT, documentExtensions } from './document-schema.js'

/**
 * The collaborative document editor (DOC-2).
 *
 * Everything about *what* a document may contain lives in the schema next
 * door; this file is only about wiring it to a channel and to a person. The
 * split matters because the schema is also what the collaboration server
 * stores and what every export reads, and a node type known to the editor
 * alone would be dropped by both.
 */

export interface Collaborator {
  readonly name: string
  /** Shown around their cursor, so two people editing are distinguishable. */
  readonly colour: string
}

export interface DocumentEditorProps {
  /** Where the collaboration server is, e.g. `ws://localhost:1234`. */
  readonly url: string
  readonly workspaceId: string
  readonly documentId: string
  /**
   * Obtains a ticket for the channel.
   *
   * A function rather than a value, because a ticket lives thirty seconds and
   * a reconnection an hour into an editing session needs a new one. Passing a
   * string would work exactly once and then fail in a way that looks like the
   * network.
   */
  readonly ticket: () => Promise<string>
  readonly user: Collaborator
}

export function DocumentEditor({
  url,
  workspaceId,
  documentId,
  ticket,
  user,
}: DocumentEditorProps): JSX.Element {
  const doc = useMemo(() => new Y.Doc(), [])
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'refused'>('connecting')

  useEffect(() => {
    const connection = new HocuspocusProvider({
      url,
      name: `${workspaceId}/${documentId}`,
      document: doc,
      token: ticket,
      onAuthenticated: () => setStatus('connected'),
      // Said plainly rather than left as a spinner. An editor that looks like
      // it is loading forever teaches people to reload and lose their place;
      // one that says it could not open the document sends them somewhere
      // they can do something about it.
      onAuthenticationFailed: () => setStatus('refused'),
    })

    setProvider(connection)
    return () => {
      connection.destroy()
    }
  }, [url, workspaceId, documentId, ticket, doc])

  const editor = useEditor(
    {
      // Rendered by the client, always. The document's content lives in the
      // CRDT rather than in the server's response, so server-rendering the
      // editor would produce markup the first sync immediately replaces.
      immediatelyRender: false,
      extensions: provider
        ? [
            ...documentExtensions,
            Collaboration.configure({ document: doc, field: DOCUMENT_FRAGMENT }),
            CollaborationCursor.configure({
              provider,
              user: { name: user.name, color: user.colour },
            }),
          ]
        : documentExtensions,
      editorProps: {
        attributes: {
          class: 'chorus-document',
          // The editor is the page's main work area, and a screen reader
          // needs to be told that rather than infer it from a div.
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': 'Document body',
        },
      },
    },
    [provider],
  )

  if (status === 'refused') {
    return (
      <p role="alert" className="chorus-document-refused">
        This document could not be opened. You may no longer have access to it.
      </p>
    )
  }

  return <EditorContent editor={editor} data-status={status} />
}
