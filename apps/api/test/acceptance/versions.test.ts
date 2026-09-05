import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createRecordingMailer, createTestClient, type SignedInUser, type TestClient } from '@chorus/testing'
import { createApp } from '../../src/app.js'

/**
 * DOC-5 — version history, and an undo worth trusting.
 *
 * > Once an agent can edit a document, a reliable undo is a precondition for
 * > trust. Restore must be additive — destroying history to undo is how people
 * > lose work twice.
 *
 * So the assertions below are as much about what *survives* a restore as about
 * what it changes. A restore that produced the right text and quietly shortened
 * the history would pass a weaker version of this suite and fail the first
 * person who needed to go back twice.
 */
describe('DOC-5 version history', () => {
  let db: IsolatedDatabase
  let client: TestClient

  interface World {
    ada: SignedInUser
    workspaceId: string
    teamId: string
    documentId: string
  }

  interface Version {
    id: string
    sequence: number
    cause: string
    label: string | null
    createdBy: string
    createdAt: string
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

    return { ada, workspaceId: workspace.id, teamId: teams[0]!.id, documentId: document.id }
  }

  const write = (w: World, content: string) =>
    w.ada.patch(`/workspaces/${w.workspaceId}/documents/${w.documentId}`, {
      sections: [{ key: 'problem', content }],
    })

  const snapshot = (w: World, label?: string) =>
    w.ada.post(`/workspaces/${w.workspaceId}/documents/${w.documentId}/versions`, { label })

  const versions = async (w: World): Promise<Version[]> =>
    (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/documents/${w.documentId}/versions`)
    ).json()) as Version[]

  const exported = async (w: World): Promise<string> =>
    await (await w.ada.get(`/workspaces/${w.workspaceId}/documents/${w.documentId}/export`)).text()

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

  it('DOC-5 AC3: restoring an earlier version is additive, and history keeps growing', async () => {
    const w = await world()

    await write(w, 'The first thing we wrote.')
    const first = await snapshot(w, 'Before the rewrite')
    expect(first.status, await first.clone().text()).toBe(201)

    await write(w, 'A rewrite nobody liked.')
    await snapshot(w, 'The rewrite')

    const before = await versions(w)
    expect(before.map((v) => v.label)).toEqual(['The rewrite', 'Before the rewrite'])

    const restored = await w.ada.post(
      `/workspaces/${w.workspaceId}/documents/${w.documentId}/versions/${before[1]!.id}/restore`,
      {},
    )
    expect(restored.status, await restored.clone().text()).toBe(200)

    expect(await exported(w)).toContain('The first thing we wrote.')
    expect(await exported(w)).not.toContain('A rewrite nobody liked.')

    const after = await versions(w)
    // Nothing removed, and the restore itself recorded. Destroying history to
    // undo is how somebody loses the same work twice — once when it was
    // overwritten and once when they tried to get it back.
    expect(after.length).toBeGreaterThan(before.length)
    expect(after.map((v) => v.id)).toEqual(expect.arrayContaining(before.map((v) => v.id)))
    expect(after[0]!.cause).toBe('restore')
    expect(after[0]!.createdBy).toBe(w.ada.userId)
  })

  it('DOC-5 AC3: the state before a restore is kept, so a restore can itself be undone', async () => {
    const w = await world()
    await write(w, 'Version one.')
    await snapshot(w, 'one')
    await write(w, 'Version two, which somebody is about to lose.')

    const list = await versions(w)
    await w.ada.post(
      `/workspaces/${w.workspaceId}/documents/${w.documentId}/versions/${list[0]!.id}/restore`,
      {},
    )

    // The content at the moment of the restore was never snapshotted by
    // anybody, so the restore has to snapshot it — otherwise "undo the undo"
    // is impossible and the second version is gone for good.
    const after = await versions(w)
    const rescued = after.find((v) => v.cause === 'pre_restore')
    expect(rescued, JSON.stringify(after)).toBeDefined()

    await w.ada.post(
      `/workspaces/${w.workspaceId}/documents/${w.documentId}/versions/${rescued!.id}/restore`,
      {},
    )
    expect(await exported(w)).toContain('about to lose')
  })

  it('DOC-5 AC2: a diff shows an insertion, a deletion and a move at block level', async () => {
    const w = await world()
    await write(w, 'Alpha.\n\nBravo.\n\nCharlie.')
    const from = (await versions(w).then(async (v) => (v.length ? v : (await snapshot(w), versions(w)))))[0]!

    await write(w, 'Charlie.\n\nAlpha.\n\nDelta.')
    await snapshot(w, 'after')
    const to = (await versions(w))[0]!

    const diff = (await (
      await w.ada.get(
        `/workspaces/${w.workspaceId}/documents/${w.documentId}/versions/${from.id}/diff/${to.id}`,
      )
    ).json()) as Array<{ kind: string; text: string }>

    const kindOf = (text: string) => diff.find((line) => line.text.includes(text))?.kind
    expect(kindOf('Bravo.')).toBe('removed')
    expect(kindOf('Delta.')).toBe('added')
    // Moved, not removed-and-added. A diff that shows a reordered paragraph as
    // a deletion plus an insertion buries the one real change among two
    // imaginary ones.
    expect(kindOf('Charlie.')).toBe('moved')
  })

  it('DOC-5 AC1: accepting a set of suggested edits leaves a snapshot behind', async () => {
    const w = await world()
    await write(w, 'Finance reconcile by hand.')

    await db.admin.execute(
      `INSERT INTO document_suggestion_sets (id, workspace_id, document_id, created_by, instruction, status)
       VALUES ('set-1', $1, $2, $3, 'Fix the grammar', 'ready')`,
      [w.workspaceId, w.documentId, w.ada.userId],
    )
    await db.admin.execute(
      `INSERT INTO document_suggestions
         (id, workspace_id, set_id, sequence, original_text, replacement_text)
       VALUES ('sug-1', $1, 'set-1', 1, 'Finance reconcile by hand.', 'Finance reconciles by hand.')`,
      [w.workspaceId],
    )

    const accepted = await w.ada.post(
      `/workspaces/${w.workspaceId}/suggestion-sets/set-1/decision`,
      { decision: 'accept' },
    )
    expect(accepted.status, await accepted.clone().text()).toBe(200)

    // The moment an agent's edits land is exactly the moment somebody wants to
    // be able to go back to.
    const list = await versions(w)
    const automatic = list.find((v) => v.cause === 'suggestions_accepted')
    expect(automatic, JSON.stringify(list)).toBeDefined()
  })

  it('DOC-5 AC1: approving a document snapshots it, labelled with the cause and the approver', async () => {
    const w = await world()
    await write(w, 'Ready for review.')

    const approved = await w.ada.post(
      `/workspaces/${w.workspaceId}/documents/${w.documentId}/status`,
      { status: 'approved' },
    )
    expect(approved.status, await approved.clone().text()).toBe(200)

    const list = await versions(w)
    const version = list.find((v) => v.cause === 'approval')
    expect(version, JSON.stringify(list)).toBeDefined()
    expect(version!.createdBy).toBe(w.ada.userId)
  })

  it('DOC-5 AC4: a restore against a document that has since changed is refused, not merged', async () => {
    const w = await world()
    await write(w, 'The original.')
    await snapshot(w, 'original')
    const [target] = await versions(w)

    await write(w, 'Somebody else is mid-sentence')

    // The client restores against the version it was looking at. Between
    // reading and pressing the button, the document moved.
    const refused = await w.ada.post(
      `/workspaces/${w.workspaceId}/documents/${w.documentId}/versions/${target!.id}/restore`,
      { expectedUpdatedAt: '2020-01-01T00:00:00.000Z' },
    )

    // Refused and said so, rather than producing a document that is half one
    // version and half another. A hybrid is the outcome nobody asked for and
    // nobody can describe afterwards.
    expect(refused.status).toBe(409)
    expect(await refused.text()).toMatch(/changed|conflict/i)
    expect(await exported(w)).toContain('mid-sentence')
  })

  it('DOC-5 AC5: retention prunes ordinary snapshots and keeps the ones that are referenced', async () => {
    const w = await world()

    await write(w, 'One.')
    await snapshot(w, 'ordinary one')
    await write(w, 'Two.')
    await snapshot(w, 'ordinary two')
    await write(w, 'Three.')
    await w.ada.post(`/workspaces/${w.workspaceId}/documents/${w.documentId}/status`, {
      status: 'approved',
    })

    const before = await versions(w)
    expect(before.length).toBeGreaterThanOrEqual(3)

    // Everything older than now, which is everything.
    const pruned = await w.ada.post(
      `/workspaces/${w.workspaceId}/documents/${w.documentId}/versions/prune`,
      { keepDays: 0 },
    )
    expect(pruned.status, await pruned.clone().text()).toBe(200)

    const after = await versions(w)
    // The approval survives: it is what somebody signed off, and pruning it
    // would delete the evidence of a decision. The ordinary ones are what
    // retention is for.
    expect(after.some((v) => v.cause === 'approval')).toBe(true)
    expect(after.some((v) => v.label === 'ordinary one')).toBe(false)
  })

  it('DOC-5: a version from another workspace cannot be restored into this one', async () => {
    const w = await world()
    await write(w, 'Private.')
    await snapshot(w, 'private')
    const [version] = await versions(w)

    const bob = await client.signedInUser()
    await bob.createWorkspace('Elsewhere')

    expect(
      (
        await bob.post(
          `/workspaces/${w.workspaceId}/documents/${w.documentId}/versions/${version!.id}/restore`,
          {},
        )
      ).status,
    ).toBe(404)
  })
})
