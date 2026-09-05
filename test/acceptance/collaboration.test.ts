import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import WebSocket from 'ws'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '@chorus/api'
import { createRecordingMailer, createTestClient, type SignedInUser, type TestClient } from '@chorus/testing'
import { createCollabServer, type CollabServer } from '@chorus/collab'

/**
 * DOC-2 — the collaborative document channel.
 *
 * > Documents are the shared surface where a team agrees on what to build.
 * > Anything less than genuine multiplayer pushes people back to a tool that
 * > has it.
 *
 * The CRDT gives convergence for free, and that is exactly why the interesting
 * tests here are not about convergence. What is *ours* to get wrong is
 * persistence, authorisation and the socket's lifetime — a long-lived
 * connection authorised once, and never again, is the hole this suite exists to
 * close.
 *
 * These run headless rather than in a browser. Nothing asserted below needs a
 * DOM: awareness, merging and authorisation are all properties of the channel,
 * and testing them through two real Yjs clients against the real server is both
 * faster and more precise than driving two browser contexts. The editor's own
 * behaviour — node types, cursors as rendered — is asserted where it lives.
 */
describe('DOC-2 collaborative editing', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let collab: CollabServer
  const open: HocuspocusProvider[] = []

  interface World {
    ada: SignedInUser
    workspaceId: string
    teamId: string
    documentId: string
  }

  async function world(): Promise<World> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Documents')
    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    const document = (await (
      await ada.post(`/workspaces/${workspace.id}/teams/${teams[0]!.id}/documents`, {
        type: 'prd',
        title: 'Invoice splitting',
      })
    ).json()) as { id: string }

    return { ada, workspaceId: workspace.id, teamId: teams[0]!.id, documentId: document.id }
  }

  /** A collaboration ticket, as the web app would obtain one before connecting. */
  async function ticketFor(
    user: SignedInUser,
    workspaceId: string,
    documentId: string,
  ): Promise<{ status: number; ticket?: string; name?: string }> {
    const response = await user.post(
      `/workspaces/${workspaceId}/documents/${documentId}/collaboration-ticket`,
      {},
    )
    if (response.status !== 201) return { status: response.status }
    const body = (await response.json()) as { ticket: string; documentName: string }
    return { status: response.status, ticket: body.ticket, name: body.documentName }
  }

  /** Connects a Yjs client, resolving once the server has accepted or refused. */
  async function connect(
    name: string,
    token: string,
  ): Promise<{ provider: HocuspocusProvider; doc: Y.Doc; authorised: boolean }> {
    const doc = new Y.Doc()
    let authorised = false

    const provider = new HocuspocusProvider({
      url: collab.url,
      name,
      token,
      document: doc,
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      // A client that reconnects forever turns a refusal into a hang, and the
      // test would then fail by timing out rather than by saying what happened.
      preserveConnection: false,
    })
    open.push(provider)

    await new Promise<void>((resolve) => {
      const settle = (value: boolean) => {
        authorised = value
        resolve()
      }
      provider.on('authenticated', () => settle(true))
      provider.on('authenticationFailed', () => settle(false))
      provider.on('close', () => resolve())
      setTimeout(() => resolve(), 5_000)
    })

    return { provider, doc, authorised }
  }

  /** Waits for a condition rather than sleeping (CLAUDE.md §5). */
  async function until(what: string, predicate: () => boolean, ms = 5_000): Promise<void> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`timed out waiting for: ${what}`)
  }

  const text = (doc: Y.Doc): string => doc.getText('body').toString()

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 180_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(async () => {
    const mailer = createRecordingMailer()
    client = createTestClient(createApp({ dbConfig: db.config, mailer }), mailer)
    collab = await createCollabServer({ dbConfig: db.config, port: 0 })
  })

  afterEach(async () => {
    for (const provider of open.splice(0)) provider.destroy()
    await collab?.stop()
  })

  it('DOC-2 AC1: two clients editing one paragraph converge, with neither edit lost', async () => {
    const w = await world()
    const granted = await ticketFor(w.ada, w.workspaceId, w.documentId)
    const second = await ticketFor(w.ada, w.workspaceId, w.documentId)

    const one = await connect(granted.name!, granted.ticket!)
    const two = await connect(second.name!, second.ticket!)
    expect(one.authorised && two.authorised, 'both clients should be connected').toBe(true)

    one.doc.getText('body').insert(0, 'Finance reconciles by hand. ')
    two.doc.getText('body').insert(0, 'Part-payments are the problem. ')

    // Both sentences, on both clients. Which order they land in is the CRDT's
    // business; that neither is dropped is the requirement.
    await until('both edits on both clients', () =>
      [one.doc, two.doc].every(
        (doc) => text(doc).includes('by hand') && text(doc).includes('Part-payments'),
      ),
    )
    expect(text(one.doc)).toBe(text(two.doc))
  })

  it('DOC-2 AC2: a cursor and its nametag reach the other client, and go on disconnect', async () => {
    const w = await world()
    const first = await ticketFor(w.ada, w.workspaceId, w.documentId)
    const second = await ticketFor(w.ada, w.workspaceId, w.documentId)

    const one = await connect(first.name!, first.ticket!)
    const two = await connect(second.name!, second.ticket!)

    one.provider.setAwarenessField('user', { name: 'Ada', colour: '#8b5cf6' })
    const others = () =>
      [...two.provider.awareness!.getStates().values()].filter(
        (state) => (state as { user?: { name?: string } }).user?.name === 'Ada',
      )

    await until('the other client sees Ada', () => others().length === 1)

    // And gone when she leaves. Presence that lingers is worse than none: it
    // shows a colleague still reading a document they closed an hour ago.
    one.provider.destroy()
    await until('Ada disappears on disconnect', () => others().length === 0)
  })

  it('DOC-2 AC3: a document is complete and identical after the server restarts', async () => {
    const w = await world()
    const first = await ticketFor(w.ada, w.workspaceId, w.documentId)
    const before = await connect(first.name!, first.ticket!)

    let stored = false
    const watching = setInterval(() => {
      void db.admin
        .query<{ ydoc: Buffer | null }>(`SELECT ydoc FROM documents WHERE id = $1`, [w.documentId])
        .then((rows) => {
          stored = (rows[0]?.ydoc?.length ?? 0) > 0
        })
    }, 100)

    before.doc.getText('body').insert(0, 'A paragraph worth keeping.')

    // Waiting for the row, not for a duration and not for the client's own
    // opinion of whether it has synced. What survives a restart is what was
    // written down, so that is the thing to wait for.
    await until('the edit is persisted', () => stored, 15_000)
    before.provider.destroy()

    await collab.stop()
    collab = await createCollabServer({ dbConfig: db.config, port: 0 })

    const again = await ticketFor(w.ada, w.workspaceId, w.documentId)
    const after = await connect(again.name!, again.ticket!)
    await until('the document comes back', () => text(after.doc).includes('worth keeping'), 15_000)
    expect(text(after.doc)).toBe('A paragraph worth keeping.')
    clearInterval(watching)
  })

  it('DOC-2 AC4: edits made while disconnected merge on reconnect, without duplication', async () => {
    const w = await world()
    const first = await ticketFor(w.ada, w.workspaceId, w.documentId)
    const online = await connect(first.name!, first.ticket!)
    online.doc.getText('body').insert(0, 'Written together. ')
    await until('the shared edit lands', () => online.provider.isSynced)

    // A second client that never had a connection at all, editing its own copy
    // — which is what an offline tab is.
    const offline = new Y.Doc()
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(online.doc))
    offline.getText('body').insert(0, 'Written alone. ')

    const second = await ticketFor(w.ada, w.workspaceId, w.documentId)
    const rejoined = await connect(second.name!, second.ticket!)
    Y.applyUpdate(rejoined.doc, Y.encodeStateAsUpdate(offline))

    await until('both sentences arrive', () =>
      text(online.doc).includes('alone') && text(online.doc).includes('together'),
    )
    // Once each. A merge that duplicates is the failure mode people notice
    // last, because the document still looks plausible.
    expect(text(online.doc).match(/Written together\. /g)).toHaveLength(1)
    expect(text(online.doc).match(/Written alone\. /g)).toHaveLength(1)
  })

  it('DOC-2 AC5: a connection without a ticket is refused', async () => {
    const w = await world()
    const granted = await ticketFor(w.ada, w.workspaceId, w.documentId)

    // The socket is a public entry point. If it authorises nothing, every
    // document in the deployment is readable by anyone who can reach the port.
    const uninvited = await connect(granted.name!, 'not-a-ticket')
    expect(uninvited.authorised).toBe(false)
  })

  it('DOC-2 AC5: a member of another workspace cannot get a ticket for this document', async () => {
    const w = await world()
    const bob = await client.signedInUser()
    await bob.createWorkspace('Elsewhere')

    // Refused where the permission machinery already lives, rather than
    // reimplemented in the collaboration server — one place to be right.
    expect((await ticketFor(bob, w.workspaceId, w.documentId)).status).toBe(404)
  })

  it('DOC-2 AC5: a ticket is for one document, and will not open another', async () => {
    const w = await world()
    const other = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/documents`, {
        type: 'spec',
        title: 'Something else',
      })
    ).json()) as { id: string }

    const granted = await ticketFor(w.ada, w.workspaceId, w.documentId)
    const elsewhere = await ticketFor(w.ada, w.workspaceId, other.id)

    // Otherwise a ticket for the one document somebody may read becomes a key
    // to every document in the workspace.
    const wrong = await connect(elsewhere.name!, granted.ticket!)
    expect(wrong.authorised).toBe(false)
  })

  it('DOC-2 AC5: losing access mid-session ends the connection', async () => {
    const w = await world()
    const bob = await client.memberWithRole(w.ada, w.workspaceId, 'member')
    const granted = await ticketFor(bob, w.workspaceId, w.documentId)
    const session = await connect(granted.name!, granted.ticket!)
    expect(session.authorised).toBe(true)

    await db.admin.execute(`DELETE FROM workspace_members WHERE user_id = $1`, [bob.userId])

    // A socket authorised once and never again is a common and serious hole:
    // revoking somebody's access has no effect until they happen to reload.
    //
    // Asserted on authentication rather than on the socket being open, because
    // a client retries a closed socket. "Dropped once" is not revocation; not
    // getting back in is.
    await until('the session is no longer authenticated', () => !session.provider.isAuthenticated, 20_000)
  }, 40_000)

  it('DOC-2 AC5: a ticket does not outlive its short life', async () => {
    const w = await world()
    const granted = await ticketFor(w.ada, w.workspaceId, w.documentId)
    const first = await connect(granted.name!, granted.ticket!)
    expect(first.authorised).toBe(true)

    // Tickets travel in a URL, and a URL ends up in a proxy log, a browser
    // history and a crash report. Single use was the first design and does not
    // survive the protocol — a client authenticates more than once while
    // connecting — so the protection is the lifetime, and the lifetime has to
    // actually be enforced rather than merely recorded.
    await db.admin.execute(
      `UPDATE collaboration_tickets SET expires_at = now() - interval '1 minute'
        WHERE document_id = $1`,
      [w.documentId],
    )

    const stale = await connect(granted.name!, granted.ticket!)
    expect(stale.authorised).toBe(false)
  })
})
