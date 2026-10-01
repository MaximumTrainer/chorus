import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import {
  createRecordingMailer,
  createTestClient,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * MCP-2 — the read tools, as an agent meets them.
 *
 * Every call is made by the MCP SDK's own client over the real endpoint, and
 * every answer is compared with what the HTTP API gives the same user (AC1).
 * The tools are the agent's eyes, so what matters is that they see exactly what
 * the person would, no more, and never all of it at once (AC2).
 *
 * This suite covers the task and document tools. The brain-backed tools
 * (`search`, `get_entity`, `get_wiki_page`, `get_repo_context`) follow once
 * retrieval (BRAIN-4) serves them.
 */

const ISSUER = 'http://localhost:3000'

/** See mcp.test.ts: the SDK's two types disagree only under exactOptionalPropertyTypes. */
function asTransport(transport: StreamableHTTPClientTransport): Transport {
  return transport as unknown as Transport
}

interface ToolResult {
  readonly isError?: boolean
  readonly content: ReadonlyArray<{ type: string; text?: string }>
}

/** The text an agent reads, and — for a successful call — the data inside it. */
function textOf(result: unknown): string {
  const { content } = result as ToolResult
  return content.map((part) => part.text ?? '').join('')
}

function dataOf<T = unknown>(result: unknown): T {
  expect((result as ToolResult).isError, textOf(result)).toBeFalsy()
  return JSON.parse(textOf(result)) as T
}

describe('MCP-2 read tools', () => {
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

  /** A small result limit, so AC2 is exercised by a handful of rows rather than thousands. */
  const MAX_RESULT_CHARS = 4_000

  beforeEach(() => {
    const mailer = createRecordingMailer()
    app = createApp({
      dbConfig: db.config,
      mailer,
      baseUrl: ISSUER,
      mcp: { maxResultChars: MAX_RESULT_CHARS },
    })
    client = createTestClient(app, mailer)
  })

  async function world(scopes: string[] = ['read:artefacts']) {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Agent eyes')
    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    const created = await ada.post(`/workspaces/${workspace.id}/tokens`, { name: 'agent', scopes })
    expect(created.status, await created.clone().text()).toBe(201)
    const token = ((await created.json()) as { token: string }).token
    return { ada, workspaceId: workspace.id, teamId: teams[0]!.id, token }
  }

  async function connected(workspaceId: string, token: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${ISSUER}/workspaces/${workspaceId}/mcp`),
      { fetch: fetchFn, requestInit: { headers: { authorization: `Bearer ${token}` } } },
    )
    const mcp = new Client({ name: 'mcp-2-agent', version: '1.0.0' })
    await mcp.connect(asTransport(transport))
    return mcp
  }

  async function apiJson(user: SignedInUser, path: string): Promise<unknown> {
    const response = await user.get(path)
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json()
  }

  it('MCP-2: an MCP client reads a task and the document it came from', async () => {
    // Given a document, and a task in the same team
    const w = await world()
    const document = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/documents`, {
        type: 'prd',
        title: 'Invoice splitting',
      })
    ).json()) as { id: string }
    const task = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, {
        title: 'Split the invoice parser',
      })
    ).json()) as { id: string }

    // When an agent lists the team's tasks, reads one, and reads the document
    const mcp = await connected(w.workspaceId, w.token)
    const listed = dataOf<{ items: Array<{ id: string }> }>(
      await mcp.callTool({ name: 'list_tasks', arguments: { teamId: w.teamId } }),
    )
    const read = dataOf(await mcp.callTool({ name: 'get_task', arguments: { taskId: task.id } }))
    const doc = dataOf(
      await mcp.callTool({ name: 'get_document', arguments: { documentId: document.id } }),
    )
    const docs = dataOf<{ items: unknown[] }>(
      await mcp.callTool({ name: 'list_documents', arguments: { teamId: w.teamId } }),
    )

    // Then each is exactly what the API gives the same person (AC1)
    expect(listed.items).toEqual(
      await apiJson(w.ada, `/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`),
    )
    expect(read).toEqual(await apiJson(w.ada, `/workspaces/${w.workspaceId}/tasks/${task.id}`))
    expect(doc).toEqual(
      await apiJson(w.ada, `/workspaces/${w.workspaceId}/documents/${document.id}`),
    )
    expect(docs.items).toEqual(
      await apiJson(w.ada, `/workspaces/${w.workspaceId}/teams/${w.teamId}/documents`),
    )
    await mcp.close()
  })

  it('MCP-2: every read tool describes itself to an agent, with an input schema', async () => {
    const w = await world()
    const mcp = await connected(w.workspaceId, w.token)

    const { tools } = await mcp.listTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'get_coding_job',
        'get_document',
        'get_session',
        'get_task',
        'list_documents',
        'list_tasks',
      ].sort(),
    )
    for (const tool of tools) {
      // Written for an agent: what it is for, and what to do next (#86).
      expect(tool.description?.length, `${tool.name} has no real description`).toBeGreaterThan(80)
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.annotations?.readOnlyHint, `${tool.name} must say it only reads`).toBe(true)
    }
    await mcp.close()
  })

  it('MCP-2: list results are paginated with a cursor, and every page is within the size limit', async () => {
    // Given more tasks than fit in one response
    const w = await world()
    for (let i = 0; i < 30; i++) {
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, {
        title: `Task ${String(i).padStart(2, '0')} ${'with a long enough title '.repeat(3)}`,
      })
    }
    const all = (await apiJson(
      w.ada,
      `/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`,
    )) as Array<{ id: string }>

    // When an agent pages through them
    const mcp = await connected(w.workspaceId, w.token)
    const seen: Array<{ id: string }> = []
    let cursor: string | undefined
    let pages = 0
    do {
      const result = await mcp.callTool({
        name: 'list_tasks',
        arguments: { teamId: w.teamId, ...(cursor ? { cursor } : {}) },
      })
      // Then no single response exceeds the configured limit (AC2)
      expect(textOf(result).length).toBeLessThanOrEqual(MAX_RESULT_CHARS)
      const page = dataOf<{ items: Array<{ id: string }>; nextCursor?: string }>(result)
      seen.push(...page.items)
      cursor = page.nextCursor
      pages++
    } while (cursor && pages < 50)

    // and following the cursor yields every task exactly once, in order
    expect(pages).toBeGreaterThan(1)
    expect(seen.map((task) => task.id)).toEqual(all.map((task) => task.id))

    // and a smaller page can be asked for
    const small = dataOf<{ items: unknown[]; nextCursor?: string }>(
      await mcp.callTool({ name: 'list_tasks', arguments: { teamId: w.teamId, limit: 2 } }),
    )
    expect(small.items).toHaveLength(2)
    expect(small.nextCursor).toBeDefined()
    await mcp.close()
  })

  it('MCP-2: a result too large for one response is cut, with a way to read the rest', async () => {
    // Given a document larger than one response may be
    const w = await world()
    const document = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/documents`, {
        type: 'prd',
        title: 'A long one',
      })
    ).json()) as { id: string; sections: Array<{ key: string }> }
    const long = 'The parser splits invoices by supplier and by currency. '.repeat(200)
    const written = await w.ada.patch(`/workspaces/${w.workspaceId}/documents/${document.id}`, {
      sections: [{ key: document.sections[0]!.key, content: long }],
    })
    expect(written.status, await written.clone().text()).toBe(200)

    // When an agent reads it, following the continuation it is given
    const mcp = await connected(w.workspaceId, w.token)
    let text = ''
    let offset: number | undefined
    let calls = 0
    do {
      const result = (await mcp.callTool({
        name: 'get_document',
        arguments: { documentId: document.id, ...(offset !== undefined ? { offset } : {}) },
      })) as ToolResult & { _meta?: { nextOffset?: number } }
      expect(result.isError, textOf(result)).toBeFalsy()
      // Then each response is within the limit, and says where to continue
      expect(textOf(result).length).toBeLessThanOrEqual(MAX_RESULT_CHARS)
      const [body, continuation] = result.content
      text += body!.text
      const next = /offset: (\d+)/.exec(continuation?.text ?? '')?.[1]
      offset = next === undefined ? undefined : Number(next)
      calls++
    } while (offset !== undefined && calls < 50)

    // and the pieces reassemble into exactly what the API returns
    expect(calls).toBeGreaterThan(1)
    expect(JSON.parse(text)).toEqual(
      await apiJson(w.ada, `/workspaces/${w.workspaceId}/documents/${document.id}`),
    )
    await mcp.close()
  })

  it('MCP-2: a missing id, a missing scope and a malformed argument are told apart, each saying what to do', async () => {
    const w = await world()
    const mcp = await connected(w.workspaceId, w.token)

    const missing = await mcp.callTool({
      name: 'get_task',
      arguments: { taskId: '01JZZZZZZZZZZZZZZZZZZZZZZZ' },
    })
    const malformed = await mcp.callTool({ name: 'get_task', arguments: { taskId: 42 } })

    const narrow = await world(['run:coding'])
    const unscoped = await connected(narrow.workspaceId, narrow.token)
    const refused = await unscoped.callTool({
      name: 'list_tasks',
      arguments: { teamId: narrow.teamId },
    })

    for (const result of [missing, malformed, refused]) {
      expect((result as ToolResult).isError, textOf(result)).toBe(true)
    }
    expect(textOf(missing)).toMatch(/not found/i)
    expect(textOf(missing)).toMatch(/list_tasks/)
    expect(textOf(malformed)).toMatch(/taskId/)
    expect(textOf(refused)).toMatch(/read:artefacts/)
    // Three different situations, three different answers (AC5)
    expect(new Set([textOf(missing), textOf(malformed), textOf(refused)]).size).toBe(3)
    await mcp.close()
    await unscoped.close()
  })

  it("MCP-2: another workspace's id is indistinguishable from a missing one", async () => {
    // Given a task in someone else's workspace
    const theirs = await world()
    const task = (await (
      await theirs.ada.post(`/workspaces/${theirs.workspaceId}/teams/${theirs.teamId}/tasks`, {
        title: 'Not yours',
      })
    ).json()) as { id: string }

    // When an agent in another workspace asks for it, and for an id that never existed
    const mine = await world()
    const mcp = await connected(mine.workspaceId, mine.token)
    const foreign = await mcp.callTool({ name: 'get_task', arguments: { taskId: task.id } })
    const absent = await mcp.callTool({
      name: 'get_task',
      arguments: { taskId: '01JZZZZZZZZZZZZZZZZZZZZZZZ' },
    })

    // Then the two answers are the same, apart from the id the agent itself sent (AC6)
    expect((foreign as ToolResult).isError).toBe(true)
    expect(textOf(foreign).replace(task.id, '<id>')).toBe(
      textOf(absent).replace('01JZZZZZZZZZZZZZZZZZZZZZZZ', '<id>'),
    )
    await mcp.close()
  })

  /**
   * A coding job on a task, arranged directly: launching one needs a connected
   * repository and an adapter, and what is under test here is reading it back.
   */
  async function aCodingJob(
    workspaceId: string,
    teamId: string,
    taskId: string,
    requestedBy: string,
  ): Promise<string> {
    const id = (suffix: string) => `${taskId.slice(0, 20)}${suffix}`
    await db.admin.execute(
      `INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'reference')`,
      [id('INTG01'), workspaceId],
    )
    await db.admin.execute(
      `INSERT INTO repositories (id, workspace_id, team_id, integration_id, provider, full_name)
       VALUES ($1, $2, $3, $4, 'github', 'acme/billing')`,
      [id('REPO01'), workspaceId, teamId, id('INTG01')],
    )
    await db.admin.execute(
      `INSERT INTO coding_jobs
         (id, workspace_id, team_id, task_id, repository_id, adapter, status, branch, requested_by)
       VALUES ($1, $2, $3, $4, $5, 'reference', 'running', 'chorus/split-the-parser', $6)`,
      [id('JOB001'), workspaceId, teamId, taskId, id('REPO01'), requestedBy],
    )
    return id('JOB001')
  }

  it('MCP-2: an MCP client reads a session and a coding job', async () => {
    // Given a shaping session, and a task with a coding job running
    const w = await world()
    const session = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/sessions`, {
        entryPoint: 'idea',
        seed: 'Invoices take finance a day a week to reconcile.',
      })
    ).json()) as { id: string }
    const task = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, {
        title: 'Split the invoice parser',
      })
    ).json()) as { id: string }
    const jobId = await aCodingJob(w.workspaceId, w.teamId, task.id, w.ada.userId)

    // When an agent reads both
    const mcp = await connected(w.workspaceId, w.token)
    const readSession = dataOf(
      await mcp.callTool({ name: 'get_session', arguments: { sessionId: session.id } }),
    )
    const readJob = dataOf<{ status: string }>(
      await mcp.callTool({ name: 'get_coding_job', arguments: { jobId } }),
    )

    // Then each is exactly what the API gives the same person (AC1)
    expect(readSession).toEqual(
      await apiJson(w.ada, `/workspaces/${w.workspaceId}/sessions/${session.id}`),
    )
    expect(readJob).toEqual(await apiJson(w.ada, `/workspaces/${w.workspaceId}/coding-jobs/${jobId}`))
    expect(readJob.status).toBe('running')
    await mcp.close()
  })

  it("MCP-2: another workspace's coding job is indistinguishable from a missing one", async () => {
    const theirs = await world()
    const task = (await (
      await theirs.ada.post(`/workspaces/${theirs.workspaceId}/teams/${theirs.teamId}/tasks`, {
        title: 'Not yours',
      })
    ).json()) as { id: string }
    const jobId = await aCodingJob(theirs.workspaceId, theirs.teamId, task.id, theirs.ada.userId)

    const mine = await world()
    const mcp = await connected(mine.workspaceId, mine.token)
    const foreign = await mcp.callTool({ name: 'get_coding_job', arguments: { jobId } })
    const absent = await mcp.callTool({
      name: 'get_coding_job',
      arguments: { jobId: '01JZZZZZZZZZZZZZZZZZZZZZZZ' },
    })

    expect((foreign as ToolResult).isError).toBe(true)
    expect(textOf(foreign)).toMatch(/not found/i)
    expect(textOf(foreign).replace(jobId, '<id>')).toBe(
      textOf(absent).replace('01JZZZZZZZZZZZZZZZZZZZZZZZ', '<id>'),
    )
    await mcp.close()
  })
})
