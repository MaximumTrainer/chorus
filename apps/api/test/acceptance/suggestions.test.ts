import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createFakeModelProvider, createRecordingMailer, createTestClient, type FakeModelProvider, type SignedInUser, type TestClient } from '@chorus/testing'
import { createApp } from '../../src/app.js'
import { createEditSuggester } from '../../src/edit-suggester.js'

/**
 * DOC-3 — the agent suggests, the author decides.
 *
 * > An agent that rewrites your document in place is an agent you stop
 * > trusting after the first bad rewrite.
 *
 * Which makes the central property a *negative* one, and negatives are the
 * ones that rot quietly: until somebody accepts a suggestion, the document must
 * be unchanged — not nearly unchanged, not changed in a way the editor happens
 * to hide. So these tests read the document back through every path a reader
 * has (the API, the export) and compare it to what was there before.
 */
describe('DOC-3 suggested edits', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let models: FakeModelProvider

  interface World {
    ada: SignedInUser
    workspaceId: string
    teamId: string
    documentId: string
  }

  /** A document with something in it worth editing. */
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

    const written = await ada.patch(`/workspaces/${workspace.id}/documents/${document.id}`, {
      sections: [
        { key: 'problem', content: 'Finance reconcile by hand. It takes a day a week.' },
        { key: 'outcome', content: 'Payments split across invoices.' },
      ],
    })
    expect(written.status, await written.clone().text()).toBe(200)

    return {
      ada,
      workspaceId: workspace.id,
      teamId: teams[0]!.id,
      documentId: document.id,
    }
  }

  const exported = async (w: World): Promise<string> =>
    (await (await w.ada.get(`/workspaces/${w.workspaceId}/documents/${w.documentId}/export`)).text())

  /** What the model is scripted to propose. */
  const propose = (suggestions: Array<{ original: string; replacement: string; why?: string }>) => {
    models.script({ chunks: [JSON.stringify({ suggestions })] })
  }

  interface SuggestionSet {
    id: string
    status: string
    error: string | null
    suggestions: Array<{
      id: string
      status: string
      originalText: string
      replacementText: string
      reason: string | null
    }>
  }

  async function ask(
    w: World,
    instruction: string,
    selection?: { from: number; to: number },
  ): Promise<{ status: number; set: SuggestionSet }> {
    const response = await w.ada.post(
      `/workspaces/${w.workspaceId}/documents/${w.documentId}/suggestions`,
      { instruction, ...(selection ?? {}) },
    )
    return { status: response.status, set: (await response.json()) as SuggestionSet }
  }

  const decide = (w: World, suggestionId: string, decision: string) =>
    w.ada.post(`/workspaces/${w.workspaceId}/suggestions/${suggestionId}/decision`, { decision })

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    models = createFakeModelProvider()
    client = createTestClient(
      createApp({
        dbConfig: db.config,
        mailer,
        suggestEdits: createEditSuggester(db.config, {
          models,
          modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
        }),
      }),
      mailer,
    )
  })

  it('DOC-3 AC1: suggestions leave the document exactly as it was', async () => {
    const w = await world()
    const before = await exported(w)

    propose([
      { original: 'Finance reconcile by hand.', replacement: 'Finance reconciles by hand.' },
      { original: 'It takes a day a week.', replacement: 'It costs a day a week.' },
    ])
    const { status, set } = await ask(w, 'Fix the grammar')

    expect(status, JSON.stringify(set)).toBe(201)
    expect(set.status).toBe('ready')
    expect(set.suggestions).toHaveLength(2)
    expect(set.suggestions.every((s) => s.status === 'pending')).toBe(true)

    // Byte-identical through every path a reader has. A suggestion the export
    // can see is a suggestion that has already been published.
    expect(await exported(w)).toBe(before)
    const read = (await (
      await w.ada.get(`/workspaces/${w.workspaceId}/documents/${w.documentId}`)
    ).json()) as { sections: Array<{ key: string; content: string }> }
    expect(read.sections.find((s) => s.key === 'problem')!.content).toContain('reconcile by hand')
  })

  it('DOC-3 AC2: rejecting every suggestion restores nothing, because nothing changed', async () => {
    const w = await world()
    const before = await exported(w)

    propose([
      { original: 'Finance reconcile by hand.', replacement: 'Something else entirely.' },
      { original: 'Payments split across invoices.', replacement: 'Or this.' },
    ])
    const { set } = await ask(w, 'Rewrite it')

    for (const suggestion of set.suggestions) {
      expect((await decide(w, suggestion.id, 'reject')).status).toBe(200)
    }

    // The strongest form of "rejection is lossless": there was never anything
    // to undo. An implementation that applied edits and rolled them back would
    // pass a weaker version of this test and fail the first time a rollback did.
    expect(await exported(w)).toBe(before)
  })

  it('DOC-3 AC4: accepting one applies exactly that one, and says who accepted it', async () => {
    const w = await world()

    propose([
      { original: 'Finance reconcile by hand.', replacement: 'Finance reconciles by hand.' },
      { original: 'Payments split across invoices.', replacement: 'Payments are split.' },
    ])
    const { set } = await ask(w, 'Fix the grammar')

    const accepted = await decide(w, set.suggestions[0]!.id, 'accept')
    expect(accepted.status, await accepted.clone().text()).toBe(200)

    const after = await exported(w)
    expect(after).toContain('Finance reconciles by hand.')
    // The one nobody decided is still only a suggestion.
    expect(after).toContain('Payments split across invoices.')
    expect(after).not.toContain('Payments are split.')

    // Attributed. An edit that appears in a document with no record of who
    // agreed to it is indistinguishable from the agent having written it
    // unasked, which is the thing this whole requirement exists to prevent.
    const [row] = await db.admin.query<{ decided_by: string; status: string }>(
      `SELECT decided_by, status FROM document_suggestions WHERE id = $1`,
      [set.suggestions[0]!.id],
    )
    expect(row!.status).toBe('accepted')
    expect(row!.decided_by).toBe(w.ada.userId)

    const [audited] = await db.admin.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE target_id = $1 ORDER BY at DESC LIMIT 1`,
      [set.suggestions[0]!.id],
    )
    expect(audited!.action).toBe('suggestion.accept')
  })

  it('DOC-3 AC3: a suggestion outside the selection is refused, not quietly kept', async () => {
    const w = await world()

    // The model was asked about one sentence and answered about two. Keeping
    // the out-of-scope one would edit text the person never offered up, which
    // is exactly the surprise selection scoping exists to prevent.
    propose([
      { original: 'Finance reconcile by hand.', replacement: 'Finance reconciles by hand.' },
      { original: 'Payments split across invoices.', replacement: 'Unasked-for rewrite.' },
    ])

    const body = await exported(w)
    const from = body.indexOf('Finance reconcile by hand.')
    const { set } = await ask(w, 'Fix the grammar', {
      from,
      to: from + 'Finance reconcile by hand.'.length,
    })

    expect(set.suggestions).toHaveLength(1)
    expect(set.suggestions[0]!.originalText).toBe('Finance reconcile by hand.')
  })

  it('DOC-3 AC5: a suggestion whose text has since changed is refused, not applied', async () => {
    const w = await world()

    propose([
      { original: 'Finance reconcile by hand.', replacement: 'Finance reconciles by hand.' },
    ])
    const { set } = await ask(w, 'Fix the grammar')

    // Somebody edits the same sentence while the suggestion is pending.
    await w.ada.patch(`/workspaces/${w.workspaceId}/documents/${w.documentId}`, {
      sections: [{ key: 'problem', content: 'Finance reconcile by hand, every Friday.' }],
    })

    const refused = await decide(w, set.suggestions[0]!.id, 'accept')

    // Refused rather than applied. Applying it would overwrite a change made
    // after the suggestion was written, by somebody who never saw it — and the
    // person accepting would have no idea they had done that.
    expect(refused.status).toBe(409)
    expect(await refused.text()).toMatch(/stale|changed/i)
    expect(await exported(w)).toContain('every Friday')

    const [row] = await db.admin.query<{ status: string }>(
      `SELECT status FROM document_suggestions WHERE id = $1`,
      [set.suggestions[0]!.id],
    )
    // Marked, not left pending: a suggestion that can never apply should stop
    // being offered.
    expect(row!.status).toBe('stale')
  })

  it('DOC-3 AC6: a model that fails leaves a set that says so, and no edit', async () => {
    const w = await world()
    const before = await exported(w)

    models.script({ failWith: 'the provider is down' })
    const { status, set } = await ask(w, 'Improve this')

    // A set in a failed state rather than an empty one: "the model failed" and
    // "the model had nothing to suggest" are different answers, and only one of
    // them is worth offering a retry for.
    expect(status).toBe(201)
    expect(set.status).toBe('failed')
    expect(set.error).toMatch(/down|fail/i)
    expect(set.suggestions).toHaveLength(0)
    expect(await exported(w)).toBe(before)
  })

  it('DOC-3 AC6: output that is not usable fails the set rather than half-applying', async () => {
    const w = await world()
    const before = await exported(w)

    models.script({ chunks: ['I think the grammar could be better, honestly.'] })
    const { set } = await ask(w, 'Improve this')

    expect(set.status).toBe('failed')
    expect(await exported(w)).toBe(before)
  })

  it('DOC-3: a suggestion naming text the document does not contain is dropped at generation', async () => {
    const w = await world()

    // Models invent quotations. One kept and offered would apply to nothing —
    // or worse, to something that merely looks like it.
    propose([
      { original: 'Finance reconcile by hand.', replacement: 'Finance reconciles by hand.' },
      { original: 'A sentence nobody wrote.', replacement: 'Anything.' },
    ])
    const { set } = await ask(w, 'Fix the grammar')

    expect(set.suggestions).toHaveLength(1)
    expect(set.suggestions[0]!.originalText).toBe('Finance reconcile by hand.')
  })

  it('DOC-3: a set can be decided in bulk, and an already-decided one is left alone', async () => {
    const w = await world()

    propose([
      { original: 'Finance reconcile by hand.', replacement: 'Finance reconciles by hand.' },
      { original: 'It takes a day a week.', replacement: 'It costs a day a week.' },
    ])
    const { set } = await ask(w, 'Fix the grammar')

    expect((await decide(w, set.suggestions[0]!.id, 'reject')).status).toBe(200)

    const bulk = await w.ada.post(
      `/workspaces/${w.workspaceId}/suggestion-sets/${set.id}/decision`,
      { decision: 'accept' },
    )
    expect(bulk.status, await bulk.clone().text()).toBe(200)

    const after = await exported(w)
    // "Accept the rest" means the ones still open, not the ones somebody has
    // already turned down.
    expect(after).toContain('Finance reconcile by hand.')
    expect(after).toContain('It costs a day a week.')
  })

  it('DOC-3: another workspace cannot decide these suggestions', async () => {
    const w = await world()
    propose([{ original: 'Finance reconcile by hand.', replacement: 'Fixed.' }])
    const { set } = await ask(w, 'Fix the grammar')

    const bob = await client.signedInUser()
    await bob.createWorkspace('Elsewhere')

    expect(
      (
        await bob.post(
          `/workspaces/${w.workspaceId}/suggestions/${set.suggestions[0]!.id}/decision`,
          { decision: 'accept' },
        )
      ).status,
    ).toBe(404)
  })
})
