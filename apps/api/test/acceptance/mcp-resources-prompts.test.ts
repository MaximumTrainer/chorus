import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createBriefBuilder } from '@chorus/coding'
import { createApp } from '../../src/app.js'
import {
  createRecordingMailer,
  createTestClient,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * MCP-4 — resources and prompts, as a real MCP client meets them.
 *
 * A resource lets an agent pin a task or a document as context without a
 * tool call per read. It arrives as Markdown whose front-matter says what it
 * is and where it lives, so the agent can cite it without a second call
 * (AC1). A document is the same Markdown its export produces (AC4), and the
 * listing is paged (AC5).
 *
 * `implement-task` is journey J7: the prompt an engineer's own agent fetches
 * is byte-for-byte the brief a sandbox would be handed (AC2). The wiki
 * resource is absent until BRAIN-5 (plan.md §2.3).
 */

const ISSUER = 'http://localhost:3000'

function asTransport(transport: StreamableHTTPClientTransport): Transport {
  return transport as unknown as Transport
}

interface Task {
  id: string
  key: string
  title: string
}

describe('MCP-4 resources and prompts', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let app: ReturnType<typeof createApp>

  const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = new URL(url.toString())
    return app.request(`${target.pathname}${target.search}`, init)
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    app = createApp({ dbConfig: db.config, mailer, baseUrl: ISSUER, mcp: { resourcePageSize: 2 } })
    client = createTestClient(app, mailer)
  })

  async function connect(user: SignedInUser, workspaceId: string, scopes = ['read:artefacts']) {
    const created = await user.post(`/workspaces/${workspaceId}/tokens`, { name: 'agent', scopes })
    expect(created.status, await created.clone().text()).toBe(201)
    const token = ((await created.json()) as { token: string }).token
    const transport = new StreamableHTTPClientTransport(
      new URL(`${ISSUER}/workspaces/${workspaceId}/mcp`),
      { fetch: fetchFn, requestInit: { headers: { authorization: `Bearer ${token}` } } },
    )
    const mcp = new Client({ name: 'mcp-4-agent', version: '1.0.0' })
    await mcp.connect(asTransport(transport))
    return mcp
  }

  async function world() {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Pinned context')
    const [team] = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    const task = (await (
      await ada.post(`/workspaces/${workspace.id}/teams/${team!.id}/tasks`, {
        title: 'Split the invoice parser',
        acceptanceCriteria: [{ text: 'Parsing is separated from validation' }],
      })
    ).json()) as Task
    const document = (await (
      await ada.post(`/workspaces/${workspace.id}/teams/${team!.id}/documents`, {
        type: 'prd',
        title: 'Invoice splitting',
      })
    ).json()) as { id: string; sections: Array<{ key: string }> }
    const written = await ada.patch(`/workspaces/${workspace.id}/documents/${document.id}`, {
      sections: [{ key: document.sections[0]!.key, content: 'Finance reconciles invoices **by hand**.' }],
    })
    expect(written.status, await written.clone().text()).toBe(200)
    const mcp = await connect(ada, workspace.id)
    return { ada, workspaceId: workspace.id, teamId: team!.id, task, documentId: document.id, mcp }
  }

  /** The front-matter of a Markdown resource, as key: value pairs. */
  function frontMatterOf(markdown: string): Record<string, string> {
    const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown)
    expect(match, `no front-matter in:\n${markdown.slice(0, 200)}`).not.toBeNull()
    return Object.fromEntries(
      match![1]!.split('\n').map((line) => {
        const at = line.indexOf(':')
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
      }),
    )
  }

  it('MCP-4: a client fetches a task resource and the implement-task prompt and receives the sandbox brief', async () => {
    // Given a task
    const w = await world()

    // When an agent reads it as a resource
    const read = await w.mcp.readResource({ uri: `chorus://task/${w.task.id}` })

    // Then it is Markdown whose front-matter is enough to cite it
    const [content] = read.contents as Array<{ uri: string; mimeType?: string; text?: string }>
    expect(content!.mimeType).toBe('text/markdown')
    const front = frontMatterOf(content!.text!)
    expect(front).toMatchObject({
      id: w.task.id,
      kind: 'task',
      key: w.task.key,
      url: `${ISSUER}/workspaces/${w.workspaceId}/tasks/${w.task.id}`,
    })
    expect(front.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(content!.text).toContain('Split the invoice parser')
    expect(content!.text).toContain('- [ ] Parsing is separated from validation')

    // And when it fetches implement-task for the same task
    const prompt = await w.mcp.getPrompt({ name: 'implement-task', arguments: { taskId: w.task.id } })

    // Then it receives exactly the brief a sandbox would be handed
    const text = (prompt.messages[0]!.content as { type: string; text: string }).text
    expect(text).toBe(await createBriefBuilder(db.config).forSandbox(w.workspaceId, w.task.id))
    await w.mcp.close()
  })

  it('MCP-4: a document resource is its Markdown export, under front-matter', async () => {
    const w = await world()

    const read = await w.mcp.readResource({ uri: `chorus://doc/${w.documentId}` })

    const text = (read.contents[0] as { text: string }).text
    expect(frontMatterOf(text)).toMatchObject({
      id: w.documentId,
      kind: 'document',
      type: 'prd',
      url: `${ISSUER}/workspaces/${w.workspaceId}/documents/${w.documentId}`,
    })
    const exported = await (
      await w.ada.get(`/workspaces/${w.workspaceId}/documents/${w.documentId}/export?format=markdown`)
    ).text()
    expect(text.replace(/^---\n[\s\S]*?\n---\n\n/, '')).toBe(exported)
    expect(text).toContain('**by hand**')
    await w.mcp.close()
  })

  it("MCP-4: another workspace's task resource is refused exactly like a missing one", async () => {
    const w = await world()
    const other = await world()

    const foreign = await w.mcp.readResource({ uri: `chorus://task/${other.task.id}` }).catch((error: Error) => error)
    const missing = await w.mcp.readResource({ uri: 'chorus://task/no-such-task' }).catch((error: Error) => error)

    expect(foreign).toBeInstanceOf(Error)
    expect(missing).toBeInstanceOf(Error)
    expect((foreign as Error).message.replace(other.task.id, 'ID')).toBe(
      (missing as Error).message.replace('no-such-task', 'ID'),
    )
    await w.mcp.close()
    await other.mcp.close()
  })

  it('MCP-4: resources are listed a page at a time, and only this workspace’s', async () => {
    // Given a workspace with three tasks and a document, and another workspace
    const w = await world()
    for (const title of ['Second', 'Third']) {
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, { title })
    }
    const other = await world()

    // When the agent lists resources, page by page
    const uris: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await w.mcp.listResources(cursor ? { cursor } : {})
      expect(page.resources.length).toBeLessThanOrEqual(2)
      uris.push(...page.resources.map((resource) => resource.uri))
      cursor = page.nextCursor
      pages += 1
    } while (cursor && pages < 10)

    // Then every one of its artefacts appears once, and none of the other's
    expect(pages).toBeGreaterThan(1)
    expect(uris).toContain(`chorus://task/${w.task.id}`)
    expect(uris).toContain(`chorus://doc/${w.documentId}`)
    expect(uris.filter((uri) => uri.startsWith('chorus://task/'))).toHaveLength(3)
    expect(new Set(uris).size).toBe(uris.length)
    expect(uris).not.toContain(`chorus://task/${other.task.id}`)
    await w.mcp.close()
    await other.mcp.close()
  })

  it('MCP-4: the resource templates are task and doc, and the wiki is not offered yet', async () => {
    const w = await world()

    const { resourceTemplates } = await w.mcp.listResourceTemplates()

    expect(resourceTemplates.map((template) => template.uriTemplate).sort()).toEqual([
      'chorus://doc/{id}',
      'chorus://task/{id}',
    ])
    await w.mcp.close()
  })

  it('MCP-4: each prompt declares its arguments, with descriptions', async () => {
    const w = await world()

    const { prompts } = await w.mcp.listPrompts()

    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
      'implement-task',
      'review-spec',
      'write-tests-for-task',
    ])
    for (const prompt of prompts) {
      expect(prompt.description?.length, prompt.name).toBeGreaterThan(40)
      expect(prompt.arguments?.length, prompt.name).toBeGreaterThan(0)
      for (const argument of prompt.arguments ?? []) {
        expect(argument.description?.length, `${prompt.name}.${argument.name}`).toBeGreaterThan(10)
      }
    }
    expect(prompts.find((prompt) => prompt.name === 'implement-task')!.arguments).toContainEqual(
      expect.objectContaining({ name: 'taskId', required: true }),
    )
    await w.mcp.close()
  })

  it('MCP-4: a missing required argument is refused, naming it', async () => {
    const w = await world()

    const refused = await w.mcp.getPrompt({ name: 'implement-task', arguments: {} }).catch((error: Error) => error)

    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain('taskId')
    await w.mcp.close()
  })

  it('MCP-4: review-spec and write-tests-for-task carry the artefact they are about', async () => {
    const w = await world()

    const review = await w.mcp.getPrompt({ name: 'review-spec', arguments: { documentId: w.documentId } })
    const tests = await w.mcp.getPrompt({ name: 'write-tests-for-task', arguments: { taskId: w.task.id } })

    const reviewText = (review.messages[0]!.content as { text: string }).text
    const testsText = (tests.messages[0]!.content as { text: string }).text
    expect(reviewText).toContain('Finance reconciles invoices **by hand**.')
    expect(testsText).toContain('Parsing is separated from validation')
    expect(testsText).toContain(w.task.key)
    await w.mcp.close()
  })
})
