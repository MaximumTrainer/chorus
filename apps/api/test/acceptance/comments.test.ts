import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import {
  createRecordingMailer,
  createTestClient,
  type RecordingMailer,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'
import { createApp } from '../../src/app.js'

/**
 * DOC-4 — review happens in the margins.
 *
 * > A lost comment is worse than no comment, because someone believed it was
 * > delivered.
 *
 * Which makes the two hard cases the ones worth most of this suite: a comment
 * whose surroundings are rewritten must still point at what it was about, and
 * one whose text is deleted must become *visibly* orphaned rather than
 * quietly disappearing. The second is the one that erodes trust, because
 * nothing about it looks like a failure.
 */
describe('DOC-4 anchored comments', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let mailer: RecordingMailer

  interface World {
    ada: SignedInUser
    workspaceId: string
    teamId: string
    documentId: string
  }

  async function world(): Promise<World> {
    const ada = await client.signedInUser(undefined, 'Ada')
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

    await ada.patch(`/workspaces/${workspace.id}/documents/${document.id}`, {
      sections: [
        {
          key: 'problem',
          content: 'Finance reconciles by hand. Part-payments are the hard case. It costs a day.',
        },
      ],
    })

    return { ada, workspaceId: workspace.id, teamId: teams[0]!.id, documentId: document.id }
  }

  interface Thread {
    id: string
    quote: string
    status: string
    orphaned: boolean
    anchorFrom: number | null
    comments: Array<{ id: string; body: string; authorId: string; mentions: string[] }>
  }

  const comment = (
    w: World,
    body: { quote?: string; prefix?: string; body: string; mentions?: string[] },
    as: SignedInUser = w.ada,
  ) => as.post(`/workspaces/${w.workspaceId}/documents/${w.documentId}/comments`, body)

  const threads = async (w: World, as: SignedInUser = w.ada): Promise<Thread[]> =>
    (await (
      await as.get(`/workspaces/${w.workspaceId}/documents/${w.documentId}/comments`)
    ).json()) as Thread[]

  const rewrite = (w: World, content: string) =>
    w.ada.patch(`/workspaces/${w.workspaceId}/documents/${w.documentId}`, {
      sections: [{ key: 'problem', content }],
    })

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    mailer = createRecordingMailer()
    client = createTestClient(createApp({ dbConfig: db.config, mailer }), mailer)
  })

  it('DOC-4 AC1: a comment stays on its phrase while the text around it is rewritten', async () => {
    const w = await world()
    const posted = await comment(w, {
      quote: 'Part-payments are the hard case.',
      body: 'Which system splits them?',
    })
    expect(posted.status, await posted.clone().text()).toBe(201)

    // Everything around the quoted phrase changes: text before it, after it,
    // and the length of both. An anchor held as a position would now point
    // into the middle of a different sentence.
    await rewrite(
      w,
      'Reconciliation is manual and slow, every week without exception. ' +
        'Part-payments are the hard case. ' +
        'It costs a day, sometimes two.',
    )

    const [thread] = await threads(w)
    expect(thread!.orphaned).toBe(false)
    expect(thread!.quote).toBe('Part-payments are the hard case.')
    expect(thread!.anchorFrom).toBeGreaterThan(0)
  })

  it('DOC-4 AC2: deleting the anchored text orphans the comment and keeps the quote', async () => {
    const w = await world()
    await comment(w, { quote: 'Part-payments are the hard case.', body: 'Which system?' })

    await rewrite(w, 'Finance reconciles by hand. It costs a day.')

    const [thread] = await threads(w)
    // Shown, not deleted. A comment that vanishes with the text it was about
    // takes the objection with it, and the person who raised it believes it
    // was delivered.
    expect(thread).toBeDefined()
    expect(thread!.orphaned).toBe(true)
    expect(thread!.quote).toBe('Part-payments are the hard case.')
    expect(thread!.anchorFrom).toBeNull()
    expect(thread!.comments[0]!.body).toBe('Which system?')
  })

  it('DOC-4 AC3: a thread keeps its replies through resolve and reopen', async () => {
    const w = await world()
    const created = (await (
      await comment(w, { quote: 'It costs a day.', body: 'Is that measured?' })
    ).json()) as Thread

    const bob = await client.memberWithRole(w.ada, w.workspaceId, 'member', undefined, 'Grace')
    const replied = await bob.post(
      `/workspaces/${w.workspaceId}/comment-threads/${created.id}/replies`,
      { body: 'Yes, from the finance log.' },
    )
    expect(replied.status, await replied.clone().text()).toBe(201)

    const resolved = await w.ada.post(
      `/workspaces/${w.workspaceId}/comment-threads/${created.id}/resolution`,
      { resolved: true },
    )
    expect(resolved.status).toBe(200)
    expect((await threads(w))[0]!.status).toBe('resolved')

    const reopened = await w.ada.post(
      `/workspaces/${w.workspaceId}/comment-threads/${created.id}/resolution`,
      { resolved: false },
    )
    expect(reopened.status).toBe(200)

    const [thread] = await threads(w)
    expect(thread!.status).toBe('open')
    // Both messages, in order. Resolving is a state change, not a deletion —
    // the reasoning is the part worth keeping, and it is what somebody
    // reopening the thread needs to read.
    expect(thread!.comments.map((c) => c.body)).toEqual([
      'Is that measured?',
      'Yes, from the finance log.',
    ])
  })

  it('DOC-4 AC4: a mention notifies, in-app and by email, and links to the comment', async () => {
    const w = await world()
    const grace = await client.memberWithRole(w.ada, w.workspaceId, 'member', undefined, 'Grace')

    const posted = await comment(w, {
      quote: 'It costs a day.',
      body: 'Grace, do you have the number?',
      mentions: [grace.userId],
    })
    expect(posted.status).toBe(201)
    const thread = (await posted.json()) as Thread

    const inbox = (await (
      await grace.get(`/workspaces/${w.workspaceId}/notifications`)
    ).json()) as { notifications: Array<{ kind: string; path: string | null; subject: string }> }

    const mention = inbox.notifications.find((n) => n.kind === 'mention')
    expect(mention, JSON.stringify(inbox)).toBeDefined()
    // To the exact anchor, not to the document. "Somebody mentioned you
    // somewhere in a long document" is a notification that costs more to act
    // on than it saves.
    expect(mention!.path).toContain(thread.id)
    expect(mention!.path).toContain(w.documentId)

    expect(mailer.to(grace.email).length).toBeGreaterThan(0)
  })

  it('DOC-4 AC4: mentioning somebody who is not in the workspace is refused', async () => {
    const w = await world()
    const outsider = await client.signedInUser()
    await outsider.createWorkspace('Elsewhere')

    const refused = await comment(w, {
      quote: 'It costs a day.',
      body: 'Thoughts?',
      mentions: [outsider.userId],
    })

    // Refused rather than dropped. A mention that silently does nothing is the
    // same failure as a lost comment: somebody believes a colleague was asked.
    expect(refused.status).toBe(400)
    expect(await refused.text()).toMatch(/member|workspace/i)
    expect(await threads(w)).toHaveLength(0)
  })

  it('DOC-4 AC5: somebody outside the workspace can neither read nor post comments', async () => {
    const w = await world()
    await comment(w, { quote: 'It costs a day.', body: 'Private discussion.' })

    const bob = await client.signedInUser()
    await bob.createWorkspace('Elsewhere')

    expect(
      (await bob.get(`/workspaces/${w.workspaceId}/documents/${w.documentId}/comments`)).status,
    ).toBe(404)
    expect((await comment(w, { quote: 'It costs a day.', body: 'Hello' }, bob)).status).toBe(404)
  })

  it('DOC-4: a quote appearing twice is disambiguated by what precedes it', async () => {
    const w = await world()
    await rewrite(w, 'Split the payment. Then split the payment again.')

    const posted = await comment(w, {
      quote: 'split the payment',
      prefix: 'Then ',
      body: 'This one.',
    })
    expect(posted.status, await posted.clone().text()).toBe(201)

    const [thread] = await threads(w)
    // The second occurrence, because that is the one the prefix identifies.
    // Anchoring to the first would put the comment against a sentence nobody
    // was reading.
    expect(thread!.orphaned).toBe(false)
    expect(thread!.anchorFrom).toBeGreaterThan('Split the payment. Then '.length - 1)
  })

  it('DOC-4: a comment on text the document does not contain is refused at the point of writing', async () => {
    const w = await world()

    // Better to refuse than to accept a comment that is orphaned the moment it
    // is made: the author is still here and can point at something real.
    const refused = await comment(w, { quote: 'A sentence nobody wrote.', body: 'Hm.' })
    expect(refused.status).toBe(400)
    expect(await refused.text()).toMatch(/not found|does not/i)
  })

  it('DOC-4: a comment needs something to say', async () => {
    const w = await world()
    expect((await comment(w, { quote: 'It costs a day.', body: '   ' })).status).toBe(400)
  })
})
