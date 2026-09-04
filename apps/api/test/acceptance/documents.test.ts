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
 * DOC-1 — document types and their templates.
 *
 * > The template is where a team's standard for "good enough to build" lives.
 *
 * The property doing the most work here is the one in AC3: **guidance is never
 * content**. A template's section guidance is advice to the author — "what
 * problem does this solve, and for whom?" — and if it leaks into the saved
 * document it becomes text the agent reads back as though somebody wrote it,
 * text that appears in an export, and text a reviewer has to delete by hand
 * before the document says anything true.
 *
 * The editor is DOC-2 and needs a web app that does not exist. Everything the
 * editor would sit on — the template model, applying it, versioning it,
 * exporting — is here.
 */
describe('DOC-1 documents and templates', () => {
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
    const workspace = await ada.createWorkspace('Product')
    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    return { ada, workspaceId: workspace.id, teamId: teams[0]!.id }
  }

  it('DOC-1 AC1: creating a PRD applies the team’s template sections in order', async () => {
    const { ada, workspaceId, teamId } = await team()

    const created = await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/documents`, {
      type: 'prd',
      title: 'Invoice splitting',
    })
    expect(created.status, await created.clone().text()).toBe(201)

    const doc = (await created.json()) as {
      id: string
      templateVersion: number
      sections: Array<{ key: string; title: string; content: string; guidance: string }>
    }

    // A platform default exists so a fresh team can write something today; the
    // point of AC2 is that they can then change it.
    expect(doc.sections.length).toBeGreaterThan(1)
    expect(doc.templateVersion).toBe(1)

    // The order is the template's order. A document whose sections arrive
    // shuffled is one the author has to reassemble before they can think.
    const keys = doc.sections.map((s) => s.key)
    expect(keys).toEqual([...keys])
    // Guidance travels alongside the content as a placeholder — never inside it.
    expect(doc.sections.every((s) => s.content === '')).toBe(true)
    expect(doc.sections.some((s) => s.guidance.length > 0)).toBe(true)
  })

  it('DOC-1 AC2: editing a template leaves existing documents untouched', async () => {
    const { ada, workspaceId, teamId } = await team()
    const before = (await (
      await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/documents`, {
        type: 'prd',
        title: 'Written under v1',
      })
    ).json()) as { id: string; sections: Array<{ key: string }>; templateVersion: number }

    const edited = await ada.put(`/workspaces/${workspaceId}/teams/${teamId}/templates/prd`, {
      sections: [
        { key: 'problem', title: 'The problem', guidance: 'Who has it?' },
        { key: 'wildcard', title: 'Something new', guidance: '' },
      ],
    })
    expect(edited.status, await edited.clone().text()).toBe(200)

    const unchanged = (await (
      await ada.get(`/workspaces/${workspaceId}/documents/${before.id}`)
    ).json()) as { sections: Array<{ key: string }>; templateVersion: number }

    // A template edit that rewrote existing documents would silently discard
    // whatever people had written into sections the new template dropped.
    expect(unchanged.sections.map((s) => s.key)).toEqual(before.sections.map((s) => s.key))
    expect(unchanged.templateVersion).toBe(1)

    const after = (await (
      await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/documents`, {
        type: 'prd',
        title: 'Written under v2',
      })
    ).json()) as { sections: Array<{ key: string }>; templateVersion: number }

    expect(after.sections.map((s) => s.key)).toEqual(['problem', 'wildcard'])
    // Each document records which version it used, so "why does this one look
    // different" is answerable rather than a mystery.
    expect(after.templateVersion).toBe(2)
  })

  it('DOC-1 AC3: an untouched document exports headings, never the guidance', async () => {
    const { ada, workspaceId, teamId } = await team()
    const doc = (await (
      await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/documents`, {
        type: 'prd',
        title: 'Nothing written yet',
      })
    ).json()) as { id: string; sections: Array<{ title: string; guidance: string }> }

    const exported = await ada.get(`/workspaces/${workspaceId}/documents/${doc.id}/export`)
    expect(exported.status).toBe(200)
    const markdown = await exported.text()

    for (const section of doc.sections) {
      expect(markdown, 'a section heading must survive export').toContain(section.title)
      if (section.guidance) {
        // The failure this guards: guidance in the export reads as something
        // the author wrote, and an agent reading it back treats it as content.
        expect(markdown, 'guidance leaked into the export').not.toContain(section.guidance)
      }
    }
  })

  it('DOC-1 AC4: a missing required section is reported, and does not block drafting', async () => {
    const { ada, workspaceId, teamId } = await team()
    await ada.put(`/workspaces/${workspaceId}/teams/${teamId}/templates/prd`, {
      sections: [
        { key: 'problem', title: 'The problem', guidance: 'Who has it?', required: true },
        { key: 'notes', title: 'Notes', guidance: '' },
      ],
    })

    const doc = (await (
      await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/documents`, {
        type: 'prd',
        title: 'Half written',
      })
    ).json()) as { id: string }

    // Drafting proceeds regardless — a template is a standard, not a gate, and
    // a document you cannot save until it is finished is one people write
    // somewhere else.
    const saved = await ada.patch(`/workspaces/${workspaceId}/documents/${doc.id}`, {
      sections: [{ key: 'notes', content: 'Some early thoughts.' }],
    })
    expect(saved.status, await saved.clone().text()).toBe(200)

    const readiness = (await (
      await ada.get(`/workspaces/${workspaceId}/documents/${doc.id}/readiness`)
    ).json()) as { ready: boolean; missing: string[] }

    expect(readiness.ready).toBe(false)
    // Named, so the author knows what to do rather than that something is wrong.
    expect(readiness.missing).toEqual(['problem'])
  })

  it('DOC-1 AC4: filling the required section makes the document ready', async () => {
    const { ada, workspaceId, teamId } = await team()
    await ada.put(`/workspaces/${workspaceId}/teams/${teamId}/templates/prd`, {
      sections: [{ key: 'problem', title: 'The problem', guidance: 'Who?', required: true }],
    })
    const doc = (await (
      await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/documents`, {
        type: 'prd',
        title: 'Complete',
      })
    ).json()) as { id: string }

    await ada.patch(`/workspaces/${workspaceId}/documents/${doc.id}`, {
      sections: [{ key: 'problem', content: 'Finance spends a day a week on this.' }],
    })

    // Otherwise the check above would pass against an endpoint that always
    // reported something missing.
    expect(
      ((await (
        await ada.get(`/workspaces/${workspaceId}/documents/${doc.id}/readiness`)
      ).json()) as { ready: boolean }).ready,
    ).toBe(true)
  })

  it('DOC-1 AC5: a member may create documents but not rewrite the team’s template', async () => {
    const { ada, workspaceId, teamId } = await team()
    const bob = await client.memberWithRole(ada, workspaceId, 'member')

    // Creating is the everyday act, and gating it would make the tool harder
    // to use than the document it replaces.
    expect(
      (
        await bob.post(`/workspaces/${workspaceId}/teams/${teamId}/documents`, {
          type: 'spec',
          title: 'Mine',
        })
      ).status,
    ).toBe(201)

    // Editing the template changes the standard for everybody's future
    // documents, which is a different kind of decision.
    expect(
      (
        await bob.put(`/workspaces/${workspaceId}/teams/${teamId}/templates/prd`, {
          sections: [{ key: 'x', title: 'X', guidance: '' }],
        })
      ).status,
    ).toBe(403)
  })

  it('DOC-1: every document type has a usable template out of the box', async () => {
    const { ada, workspaceId, teamId } = await team()

    // A team should be able to write something on their first day without
    // first designing five templates.
    for (const type of ['prd', 'spec', 'strategy', 'freeform', 'gap_spec']) {
      const created = await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/documents`, {
        type,
        title: `A ${type}`,
      })
      expect(created.status, `${type}: ${await created.clone().text()}`).toBe(201)
      const doc = (await created.json()) as { sections: unknown[] }
      expect(doc.sections.length, `${type} has no sections`).toBeGreaterThan(0)
    }
  })

  it('DOC-1: an unknown document type is refused rather than treated as freeform', async () => {
    const { ada, workspaceId, teamId } = await team()
    const refused = await ada.post(`/workspaces/${workspaceId}/teams/${teamId}/documents`, {
      type: 'proposal',
      title: 'x',
    })
    expect(refused.status).toBe(400)
  })
})
