import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { EditorPanel } from './editor-panel.js'

/**
 * A document, open (DOC-2).
 *
 * Server-rendered down to the point where the CRDT takes over. The title and
 * the identity of the person reading come from the API on the server, using
 * their session cookie, so an unauthorised reader is turned away before any
 * markup is produced — rather than being shown a shell that fails to connect
 * and looks like a network problem.
 */
export default async function DocumentPage({
  params,
}: {
  params: Promise<{ workspaceId: string; documentId: string }>
}): Promise<JSX.Element> {
  const { workspaceId, documentId } = await params
  const api = process.env.CHORUS_API_URL ?? 'http://localhost:3000'
  const cookie = (await cookies()).toString()

  const response = await fetch(`${api}/workspaces/${workspaceId}/documents/${documentId}`, {
    headers: { cookie },
    cache: 'no-store',
  })

  // 404 for a document in another workspace as much as for one that does not
  // exist: the API answers that way deliberately, and repeating the
  // distinction here would leak what it withholds.
  if (!response.ok) redirect('/')

  const document = (await response.json()) as { id: string; title: string }
  // The authentication library's own session endpoint, rather than a route
  // invented for this page. A name is what a collaborator's cursor is labelled
  // with, and it is already in the session — adding an endpoint to restate it
  // would be a new permission surface for something nobody is being told.
  const session = (await (
    await fetch(`${api}/auth/get-session`, { headers: { cookie }, cache: 'no-store' })
  ).json()) as { user?: { name?: string; email?: string } } | null

  return (
    <main>
      <h1>{document.title}</h1>
      <EditorPanel
        workspaceId={workspaceId}
        documentId={documentId}
        collabUrl={process.env.CHORUS_COLLAB_URL ?? 'ws://localhost:1234'}
        apiUrl={api}
        name={session?.user?.name || session?.user?.email || 'Someone'}
        origin={(await headers()).get('host') ?? ''}
      />
    </main>
  )
}
