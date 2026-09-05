import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createRecordingMailer, createTestClient, type SignedInUser, type TestClient } from '@chorus/testing'
import { createApp } from '../../src/app.js'
import { encodeBody } from '@chorus/ui/schema'
import type { DocumentBody } from '@chorus/core'

/**
 * DOC-7 — export, the anti-lock-in guarantee.
 *
 * > For an open-source, self-hostable product it is close to a moral
 * > obligation. It is also how documents reach people without accounts.
 *
 * Which is why the interesting assertions are about what *survives*. A table
 * that exports as prose, an image that exports as nothing, a link that exports
 * pointing at a path only this deployment understands — each is a document that
 * arrives somewhere looking complete and is not.
 */
describe('DOC-7 export', () => {
  let db: IsolatedDatabase
  let client: TestClient
  const BASE = 'https://chorus.example'

  interface World {
    ada: SignedInUser
    workspaceId: string
    documentId: string
  }

  /** A document containing one of everything the requirement lists. */
  const everything = (workspaceId: string, taskId: string): DocumentBody => ({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2, sectionKey: 'problem' }, content: [{ type: 'text', text: 'Problem' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'See ' },
          {
            type: 'text',
            text: 'the parser task',
            marks: [{ type: 'link', attrs: { href: `/workspaces/${workspaceId}/tasks/${taskId}` } }],
          },
          { type: 'text', text: ' and ' },
          {
            type: 'text',
            text: 'the standard',
            marks: [{ type: 'link', attrs: { href: 'https://example.test/spec' } }],
          },
          { type: 'text', text: '.' },
        ],
      },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A bullet' }] }] },
        ],
      },
      {
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: true },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Done already' }] }],
          },
        ],
      },
      {
        type: 'codeBlock',
        attrs: { language: 'ts' },
        content: [{ type: 'text', text: 'const rate = 0.2 < 1 && true' }],
      },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Header' }] }] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cell' }] }] },
            ],
          },
        ],
      },
      { type: 'image', attrs: { src: '/attachments/diagram.png', alt: 'A diagram' } },
    ],
  })

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
    const task = (await (
      await ada.post(`/workspaces/${workspace.id}/teams/${teams[0]!.id}/tasks`, {
        title: 'Split the parser',
      })
    ).json()) as { id: string }

    // Written straight into the body: the point of this suite is the export,
    // and building every node type through the editor would be testing the
    // editor instead.
    await db.admin.execute(`UPDATE documents SET ydoc = $2 WHERE id = $1`, [
      document.id,
      encodeBody(everything(workspace.id, task.id)),
    ])

    return { ada, workspaceId: workspace.id, documentId: document.id }
  }

  const exportAs = async (w: World, format?: string): Promise<{ status: number; text: string }> => {
    const query = format ? `?format=${format}` : ''
    const response = await w.ada.get(
      `/workspaces/${w.workspaceId}/documents/${w.documentId}/export${query}`,
    )
    return { status: response.status, text: await response.text() }
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    client = createTestClient(createApp({ dbConfig: db.config, mailer, baseUrl: BASE }), mailer)
  })

  it('DOC-7 AC1: Markdown keeps every node, as CommonMark with GFM tables', async () => {
    const w = await world()
    const { status, text } = await exportAs(w, 'markdown')

    expect(status).toBe(200)
    expect(text).toContain('# Invoice splitting')
    expect(text).toContain('## Problem')
    expect(text).toContain('- A bullet')
    expect(text).toContain('- [x] Done already')
    expect(text).toContain('```ts')
    // A GFM table, with its separator row — without it the block is three
    // lines of pipes that no renderer treats as a table.
    expect(text).toContain('| Header |')
    expect(text).toContain('| --- |')
    expect(text).toContain('| Cell |')
    expect(text).toContain('![A diagram]')
  })

  it('DOC-7 AC4: an internal link exports as an absolute URL for this deployment', async () => {
    const w = await world()
    const { text } = await exportAs(w, 'markdown')

    // A relative path is meaningful only inside the app it came from. Exported
    // as-is it becomes a link that resolves against whatever document the
    // reader happens to be in, which is worse than a broken one.
    expect(text).toContain(`${BASE}/workspaces/${w.workspaceId}/tasks/`)
    expect(text).not.toContain('](/workspaces/')
    // An external link is left exactly as it was written.
    expect(text).toContain('https://example.test/spec')
  })

  it('DOC-7 AC4: an image with a relative source is made absolute too', async () => {
    const w = await world()
    const { text } = await exportAs(w, 'markdown')
    // Otherwise the document arrives complete and every diagram in it is a
    // broken image icon.
    expect(text).toContain(`${BASE}/attachments/diagram.png`)
  })

  it('DOC-7 AC2: rich text exports as HTML that keeps its structure', async () => {
    const w = await world()
    const { status, text } = await exportAs(w, 'html')

    expect(status).toBe(200)
    expect(text).toContain('<h1>Invoice splitting</h1>')
    expect(text).toContain('<h2>Problem</h2>')
    expect(text).toContain('<ul>')
    expect(text).toContain('<li>A bullet</li>')
    // The structures a word processor actually reads on paste.
    expect(text).toContain('<table>')
    expect(text).toContain('<th>Header</th>')
    expect(text).toContain('<td>Cell</td>')
    expect(text).toContain('<pre><code class="language-ts">')
    expect(text).toContain('<img src="https://chorus.example/attachments/diagram.png"')
    expect(text).toContain('<a href="https://example.test/spec">the standard</a>')
  })

  it('DOC-7 AC2: content that looks like markup is escaped, not rendered', async () => {
    const w = await world()
    const { text } = await exportAs(w, 'html')

    // The code block contains `0.2 < 1 && true`. Emitted raw it would open a
    // tag the rest of the document then lives inside, and a document that
    // pastes as one long code block is not an export.
    expect(text).toContain('0.2 &lt; 1 &amp;&amp; true')
    expect(text).not.toContain('0.2 < 1 && true')
  })

  it('DOC-7 AC2: the HTML export says it is HTML', async () => {
    const w = await world()
    const response = await w.ada.get(
      `/workspaces/${w.workspaceId}/documents/${w.documentId}/export?format=html`,
    )
    // A word processor decides how to treat a paste from the content type. Sent
    // as text/plain it arrives as visible tags.
    expect(response.headers.get('content-type')).toContain('text/html')
  })

  it('DOC-7: an unknown format is refused rather than silently answered in another', async () => {
    const w = await world()
    const { status } = await exportAs(w, 'wordperfect')
    expect(status).toBe(400)
  })

  it('DOC-7 AC5: export is refused for somebody without access to the document', async () => {
    const w = await world()
    const bob = await client.signedInUser()
    await bob.createWorkspace('Elsewhere')

    // By document id, which is the case the criterion names: an export
    // endpoint that skipped the check because "it only reads" would be a way
    // to read any document in the deployment.
    expect(
      (await bob.get(`/workspaces/${w.workspaceId}/documents/${w.documentId}/export`)).status,
    ).toBe(404)
  })

  it('DOC-7: a selection exports on its own, without the rest of the document', async () => {
    const w = await world()
    const whole = (await exportAs(w, 'markdown')).text
    const from = whole.indexOf('- A bullet')

    const response = await w.ada.get(
      `/workspaces/${w.workspaceId}/documents/${w.documentId}/export` +
        `?format=markdown&from=${from}&to=${from + '- A bullet'.length}`,
    )
    const text = await response.text()

    expect(text.trim()).toBe('- A bullet')
    expect(text).not.toContain('Invoice splitting')
  })
})
