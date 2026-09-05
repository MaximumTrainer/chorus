'use client'

import { useCallback, useMemo } from 'react'
import { DocumentEditor } from '@chorus/ui'

/**
 * The client half of the document page.
 *
 * Its whole job is obtaining tickets. The editor asks for one whenever it
 * needs to connect, which is more than once in a long session — a ticket lives
 * thirty seconds, and a reconnection an hour in needs a fresh one.
 */
export function EditorPanel({
  workspaceId,
  documentId,
  collabUrl,
  apiUrl,
  name,
  origin,
}: {
  workspaceId: string
  documentId: string
  collabUrl: string
  apiUrl: string
  name: string
  origin: string
}): JSX.Element {
  const ticket = useCallback(async () => {
    const response = await fetch(
      `${apiUrl}/workspaces/${workspaceId}/documents/${documentId}/collaboration-ticket`,
      { method: 'POST', credentials: 'include' },
    )
    if (!response.ok) throw new Error('Could not obtain a collaboration ticket')
    return ((await response.json()) as { ticket: string }).ticket
  }, [apiUrl, workspaceId, documentId])

  // Derived from the name rather than random, so the same person is the same
  // colour on every screen. A colour that differs per viewer makes "the blue
  // cursor" mean nothing between two people looking at one document.
  const colour = useMemo(() => {
    let hash = 0
    for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) % 360
    return `hsl(${hash}, 68%, 62%)`
  }, [name])

  return (
    <DocumentEditor
      url={collabUrl}
      workspaceId={workspaceId}
      documentId={documentId}
      ticket={ticket}
      user={{ name, colour }}
      key={origin}
    />
  )
}
