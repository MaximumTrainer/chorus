import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import {
  createRecordingMailer,
  createTestClient,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * CHAT-1 — the three doors into a session.
 *
 * > The blank page is where most product tools lose their user. Three named
 * > doors, and a short list of team-configured starting moves, convert "what do
 * > I type" into "which of these am I doing".
 *
 * So the entry point is not decoration: it is recorded on the session, it is
 * the hint the workflow router keys off (AGENT-2), and *Nothing* has to stay
 * genuinely unseeded — an agent that invents a subject for somebody who said
 * they wanted to think out loud has taken the blank page and made it worse.
 *
 * The agent's first turn is CHAT-2 and needs the built-in workflows, which wait
 * on the `emit` step. What is asserted here is everything the turn will be
 * launched from: the session, its seed, its linked source, and the hint.
 */
describe('CHAT-1 session entry points', () => {
  let db: IsolatedDatabase
  let client: TestClient

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    client = createTestClient(createApp({ dbConfig: db.config, mailer }), mailer)
  })

  async function team(): Promise<{ ada: SignedInUser; workspaceId: string; teamId: string }> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Shaping')
    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    return { ada, workspaceId: workspace.id, teamId: teams[0]!.id }
  }

  it('CHAT-1 AC1: the idea door records the idea and a hint the router can use', async () => {
    const { ada, workspaceId, teamId } = await team()

    const created = await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/sessions`, {
      entryPoint: 'idea',
      seed: 'Invoices take finance a day a week to reconcile.',
    })
    expect(created.status, await created.clone().text()).toBe(201)

    const session = (await created.json()) as {
      id: string
      entryPoint: string
      title: string
      routingHint: string | null
      messages: Array<{ role: string; content: { text?: string } }>
    }

    expect(session.entryPoint).toBe('idea')
    // The seed is the first message, from the person. Storing it only on the
    // session would leave the transcript starting mid-conversation.
    expect(session.messages[0]).toMatchObject({ role: 'user' })
    expect(session.messages[0]!.content.text).toContain('Invoices take finance')
    // A title somebody can find the session by later, taken from what they
    // actually said rather than left as "Untitled".
    expect(session.title.length).toBeGreaterThan(0)
    expect(session.routingHint).toBe('shape-idea')
  })

  it('CHAT-1 AC2: the document door attaches the source and cites it as the seed', async () => {
    const { ada, workspaceId, teamId } = await team()
    const doc = (await (
      await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/documents`, {
        type: 'prd',
        title: 'Existing thinking',
      })
    ).json()) as { id: string }

    const created = await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/sessions`, {
      entryPoint: 'document',
      sourceType: 'document',
      sourceId: doc.id,
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const session = (await created.json()) as { id: string; routingHint: string | null }

    // Attached as a link rather than copied: the session points at the
    // document, so an edit to the document is not stranded behind a snapshot
    // nobody knows is stale.
    const links = (await (
      await ada.get(`/workspaces/${workspaceId}/sessions/${session.id}/sources`)
    ).json()) as Array<{ toType: string; toId: string }>
    expect(links).toContainEqual(expect.objectContaining({ toType: 'document', toId: doc.id }))
    expect(session.routingHint).toBe('draft-document')
  })

  it('CHAT-1 AC2: pasted text becomes a document, so the source is a real artefact', async () => {
    const { ada, workspaceId, teamId } = await team()

    const created = await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/sessions`, {
      entryPoint: 'document',
      pastedText: '# Notes from the workshop\n\nFinance cannot reconcile part-payments.',
      title: 'Workshop notes',
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const session = (await created.json()) as { id: string }

    // Pasted material becomes something with an id, a team and a history —
    // otherwise it is a blob on one session that nothing else can reference,
    // and the "cheapest bridge from existing material" leads nowhere.
    const links = (await (
      await ada.get(`/workspaces/${workspaceId}/sessions/${session.id}/sources`)
    ).json()) as Array<{ toType: string; toId: string }>
    expect(links).toHaveLength(1)
    expect(links[0]!.toType).toBe('document')

    const document = (await (
      await ada.get(`/workspaces/${workspaceId}/documents/${links[0]!.toId}`)
    ).json()) as { title: string; sections: Array<{ content: string }> }
    expect(document.title).toBe('Workshop notes')
    expect(document.sections.some((s) => s.content.includes('part-payments'))).toBe(true)
  })

  it('CHAT-1 AC3: the nothing door is genuinely unseeded', async () => {
    const { ada, workspaceId, teamId } = await team()

    const session = (await (
      await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/sessions`, {
        entryPoint: 'nothing',
      })
    ).json()) as {
      entryPoint: string
      routingHint: string | null
      messages: unknown[]
    }

    expect(session.entryPoint).toBe('nothing')
    // No seed message and no hint. Inventing a subject for somebody who said
    // they wanted to think out loud takes the blank page and makes it worse —
    // now they have to argue with a wrong premise before they can start.
    expect(session.messages).toEqual([])
    expect(session.routingHint).toBeNull()
  })

  it('CHAT-1 AC4: quick actions are per team, and seed the session they start', async () => {
    const { ada, workspaceId, teamId } = await team()

    const configured = await ada.put(`/workspaces/${workspaceId}/teams/${teamId}/quick-actions`, {
      actions: [
        { key: 'friction', label: 'Analyse user friction', prompt: 'Where do users get stuck?', hint: 'research' },
        { key: 'prd', label: 'Draft a PRD', prompt: 'Draft a PRD for this.', hint: 'draft-document' },
      ],
    })
    expect(configured.status, await configured.clone().text()).toBe(200)

    const listed = (await (
      await ada.get(`/workspaces/${workspaceId}/teams/${teamId}/quick-actions`)
    ).json()) as Array<{ key: string; label: string }>
    // Exactly the configured set — not the configured set plus whatever the
    // platform thinks is useful.
    expect(listed.map((a) => a.key)).toEqual(['friction', 'prd'])

    const session = (await (
      await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/sessions`, {
        entryPoint: 'quick_action',
        quickActionKey: 'friction',
      })
    ).json()) as { routingHint: string | null; messages: Array<{ content: { text?: string } }> }

    expect(session.routingHint).toBe('research')
    expect(session.messages[0]!.content.text).toBe('Where do users get stuck?')
  })

  it('CHAT-1 AC4: a quick action another team configured is not available here', async () => {
    const { ada, workspaceId, teamId } = await team()
    await ada.put(`/workspaces/${workspaceId}/teams/${teamId}/quick-actions`, {
      actions: [{ key: 'friction', label: 'Friction', prompt: 'p', hint: 'research' }],
    })

    const other = (await (
      await ada.post(`/workspaces/${workspaceId}/teams`, { name: 'Platform' })
    ).json()) as { id: string }

    // "Exactly the configured set" for *this* team. A quick action leaking
    // across teams would seed a session with another team's framing.
    expect(
      ((await (
        await ada.get(`/workspaces/${workspaceId}/teams/${other.id}/quick-actions`)
      ).json()) as unknown[]).length,
    ).toBe(0)

    const refused = await ada.post(`/workspaces/${workspaceId}/teams/${other.id}/sessions`, {
      entryPoint: 'quick_action',
      quickActionKey: 'friction',
    })
    expect(refused.status).toBe(400)
  })

  it('CHAT-1 AC4: configuring quick actions is an admin decision', async () => {
    const { ada, workspaceId, teamId } = await team()
    const bob = await client.memberWithRole(ada, workspaceId, 'member')

    // They decide how everybody on the team starts work, which is a different
    // thing from starting work.
    expect(
      (
        await bob.put(`/workspaces/${workspaceId}/teams/${teamId}/quick-actions`, {
          actions: [{ key: 'x', label: 'X', prompt: 'p' }],
        })
      ).status,
    ).toBe(403)

    expect(
      (
        await bob.post(`/workspaces/${workspaceId}/teams/${teamId}/sessions`, {
          entryPoint: 'idea',
          seed: 'Mine',
        })
      ).status,
    ).toBe(201)
  })

  it('CHAT-1 AC5: a source that cannot be reached is refused, not silently dropped', async () => {
    const { ada, workspaceId, teamId } = await team()

    // Starting a session that quietly lost its source produces an agent turn
    // grounded in nothing, which reads exactly like one grounded in something.
    const refused = await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/sessions`, {
      entryPoint: 'document',
      sourceType: 'document',
      sourceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    })
    expect(refused.status).toBe(400)
    expect(await refused.text()).toMatch(/could not|not found|no such/i)
  })

  it('CHAT-1: the document door needs something to open with', async () => {
    const { ada, workspaceId, teamId } = await team()
    const refused = await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/sessions`, {
      entryPoint: 'document',
    })
    expect(refused.status).toBe(400)
  })

  it('CHAT-1: a session in another workspace is not readable', async () => {
    const { ada, workspaceId, teamId } = await team()
    const session = (await (
      await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/sessions`, {
        entryPoint: 'idea',
        seed: 'Private thinking',
      })
    ).json()) as { id: string }

    const bob = await client.signedInUser()
    await bob.createWorkspace('Elsewhere')
    expect((await bob.get(`/workspaces/${workspaceId}/sessions/${session.id}`)).status).toBe(404)
  })
})
