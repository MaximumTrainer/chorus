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
 * MCP-3 — the write tools for tasks and documents, as an agent meets them.
 *
 * A write made over MCP must be indistinguishable from the same write made in
 * the product (AC1): same defaults, same key allocation, same audit trail. It
 * is refused for want of a scope exactly as the API refuses it (AC3), it can be
 * retried safely (AC4), and a malformed call writes nothing (AC5).
 *
 * `report_pr` is the tool that closes the loop for an engineer's own agent
 * (AC2, journey J7): the pull request it opened is attached to the task, the
 * task moves to review, and the work is recorded as done outside the platform.
 *
 * `start_coding_job` and its `before_coding_job` gate (AC6) are proven in
 * agent-launch-gate.test.ts. `log_decision` is not offered until the Decision
 * entities of CHAT-10 exist (plan.md §2.3).
 */

const ISSUER = 'http://localhost:3000'

function asTransport(transport: StreamableHTTPClientTransport): Transport {
  return transport as unknown as Transport
}

interface ToolResult {
  readonly isError?: boolean
  readonly content: ReadonlyArray<{ type: string; text?: string }>
}

function textOf(result: unknown): string {
  return (result as ToolResult).content.map((part) => part.text ?? '').join('')
}

function dataOf<T = unknown>(result: unknown): T {
  expect((result as ToolResult).isError, textOf(result)).toBeFalsy()
  return JSON.parse(textOf(result)) as T
}

interface Task {
  id: string
  key: string
  title: string
  [field: string]: unknown
}

/** What two equivalent tasks may legitimately differ in: who they and their criteria are, and when. */
const IDENTITY = ['id', 'key', 'createdAt', 'updatedAt', 'position']

function comparable(task: Task) {
  const rest = Object.fromEntries(Object.entries(task).filter(([field]) => !IDENTITY.includes(field)))
  const criteria = (task.acceptanceCriteria as Array<Record<string, unknown>>).map((criterion) =>
    Object.fromEntries(Object.entries(criterion).filter(([field]) => field !== 'id')),
  )
  return { ...rest, acceptanceCriteria: criteria }
}

describe('MCP-3 write tools', () => {
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
    app = createApp({ dbConfig: db.config, mailer, baseUrl: ISSUER })
    client = createTestClient(app, mailer)
  })

  async function world(scopes: string[] = ['read:artefacts', 'write:artefacts']) {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Agent hands')
    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    const created = await ada.post(`/workspaces/${workspace.id}/tokens`, { name: 'agent', scopes })
    expect(created.status, await created.clone().text()).toBe(201)
    const token = ((await created.json()) as { token: string }).token
    const transport = new StreamableHTTPClientTransport(
      new URL(`${ISSUER}/workspaces/${workspace.id}/mcp`),
      { fetch: fetchFn, requestInit: { headers: { authorization: `Bearer ${token}` } } },
    )
    const mcp = new Client({ name: 'mcp-3-agent', version: '1.0.0' })
    await mcp.connect(asTransport(transport))
    return { ada, workspaceId: workspace.id, teamId: teams[0]!.id, mcp }
  }

  async function apiJson<T = unknown>(user: SignedInUser, path: string): Promise<T> {
    const response = await user.get(path)
    expect(response.status, await response.clone().text()).toBe(200)
    return (await response.json()) as T
  }

  async function tasksOf(user: SignedInUser, workspaceId: string, teamId: string) {
    return apiJson<Task[]>(user, `/workspaces/${workspaceId}/teams/${teamId}/tasks`)
  }

  async function auditFor(user: SignedInUser, workspaceId: string, targetId: string) {
    const page = await apiJson<{ entries: Array<{ action: string; actorType: string; actorId: string; after: unknown }> }>(
      user,
      `/workspaces/${workspaceId}/audit?targetId=${targetId}`,
    )
    return page.entries.map(({ action, actorType, actorId, after }) => ({
      action,
      actorType,
      actorId,
      after,
    }))
  }

  it('MCP-3: the write tools are advertised as writes, and say how to retry safely', async () => {
    const w = await world()

    const { tools } = await w.mcp.listTools()
    const writes = tools.filter((tool) =>
      ['create_task', 'update_task', 'create_document', 'update_document'].includes(tool.name),
    )

    expect(writes.map((tool) => tool.name).sort()).toEqual(
      ['create_document', 'create_task', 'update_document', 'update_task'].sort(),
    )
    for (const tool of writes) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(false)
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false)
      expect(tool.description?.length, `${tool.name} has no real description`).toBeGreaterThan(80)
    }
    for (const name of ['create_task', 'create_document']) {
      const tool = writes.find((each) => each.name === name)!
      expect(Object.keys(tool.inputSchema.properties ?? {}), name).toContain('idempotencyKey')
    }
    // Not offered until it can be honoured in full (#87's phasing note).
    // start_coding_job now is, with its gate: agent-launch-gate.test.ts.
    expect(tools.map((tool) => tool.name)).not.toContain('log_decision')
    await w.mcp.close()
  })

  it('MCP-3: add_comment, link_artefacts and report_pr are advertised as writes', async () => {
    const w = await world()

    const { tools } = await w.mcp.listTools()
    for (const name of ['add_comment', 'link_artefacts', 'report_pr']) {
      const tool = tools.find((each) => each.name === name)
      expect(tool, `${name} is not advertised`).toBeDefined()
      expect(tool!.annotations?.readOnlyHint, name).toBe(false)
      expect(tool!.annotations?.destructiveHint, name).toBe(false)
      expect(tool!.description?.length, `${name} has no real description`).toBeGreaterThan(80)
    }
    await w.mcp.close()
  })

  /** A repository the workspace has connected, linked to the team (WS-3). */
  async function withRepository(w: Awaited<ReturnType<typeof world>>, fullName = 'acme/widgets') {
    const [integration] = await db.admin.query<{ id: string }>(
      `INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'github') RETURNING id`,
      [`int${Date.now()}${Math.floor(Math.random() * 1000)}`, w.workspaceId],
    )
    const linked = await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/repositories`, {
      integrationId: integration!.id,
      provider: 'github',
      fullName,
    })
    expect(linked.status, await linked.clone().text()).toBe(201)
  }

  it('MCP-3: an external agent reads a task, opens a pull request, and reports it back', async () => {
    // Given a task in a team that works in acme/widgets
    const w = await world()
    await withRepository(w)
    const task = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, {
        title: 'Split the invoice parser',
        status: 'in_progress',
      })
    ).json()) as Task

    // and an agent that read it and opened a pull request
    dataOf<Task>(await w.mcp.callTool({ name: 'get_task', arguments: { taskId: task.id } }))
    const url = 'https://github.com/acme/widgets/pull/42'

    // When it reports the pull request back
    const reported = await w.mcp.callTool({
      name: 'report_pr',
      arguments: { taskId: task.id, url, status: 'open' },
    })

    // Then the pull request is attached to the task, recorded as external work
    expect((reported as ToolResult).isError, textOf(reported)).toBeFalsy()
    const read = await apiJson<Task>(w.ada, `/workspaces/${w.workspaceId}/tasks/${task.id}`)
    expect(read.pullRequests).toEqual([
      expect.objectContaining({
        url,
        status: 'open',
        source: 'external',
        repository: 'acme/widgets',
        number: 42,
      }),
    ])
    // and the task moved to review
    expect(read.status).toBe('in_review')
    // and the report was audited as the person the agent acts for
    const audited = await auditFor(w.ada, w.workspaceId, task.id)
    expect(audited).toContainEqual(
      expect.objectContaining({ action: 'task.pull_request.report', actorType: 'user', actorId: w.ada.userId }),
    )
    await w.mcp.close()
  })

  it('MCP-3: reporting the same pull request again updates it rather than attaching it twice', async () => {
    const w = await world()
    await withRepository(w)
    const task = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, { title: 'Once' })
    ).json()) as Task
    const url = 'https://github.com/acme/widgets/pull/7'

    for (const status of ['open', 'merged']) {
      dataOf(await w.mcp.callTool({ name: 'report_pr', arguments: { taskId: task.id, url, status } }))
    }

    const read = await apiJson<Task>(w.ada, `/workspaces/${w.workspaceId}/tasks/${task.id}`)
    expect(read.pullRequests).toEqual([expect.objectContaining({ url, status: 'merged' })])
    await w.mcp.close()
  })

  it('MCP-3: report_pr refuses a pull request from a repository the workspace has not connected', async () => {
    const w = await world()
    await withRepository(w)
    const task = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, { title: 'Elsewhere' })
    ).json()) as Task

    const result = await w.mcp.callTool({
      name: 'report_pr',
      arguments: { taskId: task.id, url: 'https://github.com/someone/else/pull/1', status: 'open' },
    })

    expect((result as ToolResult).isError).toBe(true)
    expect(textOf(result)).toContain('someone/else')
    const read = await apiJson<Task>(w.ada, `/workspaces/${w.workspaceId}/tasks/${task.id}`)
    expect(read.pullRequests).toEqual([])
    expect(read.status).toBe('todo')
    await w.mcp.close()
  })

  it('MCP-3: an agent comments on a document, as the person it acts for', async () => {
    const w = await world()
    const document = dataOf<{ id: string; sections: Array<{ key: string }> }>(
      await w.mcp.callTool({
        name: 'create_document',
        arguments: { teamId: w.teamId, type: 'prd', title: 'Invoice splitting' },
      }),
    )
    dataOf(
      await w.mcp.callTool({
        name: 'update_document',
        arguments: {
          documentId: document.id,
          sections: [{ key: document.sections[0]!.key, content: 'Finance reconciles invoices by hand.' }],
        },
      }),
    )

    const result = await w.mcp.callTool({
      name: 'add_comment',
      arguments: {
        documentId: document.id,
        quote: 'reconciles invoices by hand',
        body: 'How many invoices a month is that?',
      },
    })

    expect((result as ToolResult).isError, textOf(result)).toBeFalsy()
    const threads = await apiJson<Array<{ quote: string; comments: Array<{ authorId: string; body: string }> }>>(
      w.ada,
      `/workspaces/${w.workspaceId}/documents/${document.id}/comments`,
    )
    expect(threads).toEqual([
      expect.objectContaining({
        quote: 'reconciles invoices by hand',
        comments: [expect.objectContaining({ authorId: w.ada.userId, body: 'How many invoices a month is that?' })],
      }),
    ])
    await w.mcp.close()
  })

  it('MCP-3: an agent links a task to a document, and the link is audited', async () => {
    const w = await world()
    const task = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, { title: 'Linked' })
    ).json()) as Task
    const document = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/documents`, {
        type: 'spec',
        title: 'Parser spec',
      })
    ).json()) as { id: string }

    const result = await w.mcp.callTool({
      name: 'link_artefacts',
      arguments: { taskId: task.id, toType: 'document', toId: document.id, relation: 'implements' },
    })

    expect((result as ToolResult).isError, textOf(result)).toBeFalsy()
    const scoped = await apiJson<Task[]>(
      w.ada,
      `/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks?scopeType=document&scopeId=${document.id}`,
    )
    expect(scoped.map((each) => each.id)).toEqual([task.id])
    expect(await auditFor(w.ada, w.workspaceId, task.id)).toContainEqual(
      expect.objectContaining({ action: 'task.link', actorId: w.ada.userId }),
    )
    await w.mcp.close()
  })

  it('MCP-3: link_artefacts refuses a target that does not exist, and writes nothing', async () => {
    const w = await world()
    const task = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, { title: 'Alone' })
    ).json()) as Task

    const result = await w.mcp.callTool({
      name: 'link_artefacts',
      arguments: { taskId: task.id, toType: 'document', toId: 'no-such-document' },
    })

    expect((result as ToolResult).isError).toBe(true)
    expect(textOf(result)).toContain('no-such-document')
    const scoped = await apiJson<Task[]>(
      w.ada,
      `/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks?scopeType=document&scopeId=no-such-document`,
    )
    expect(scoped).toEqual([])
    await w.mcp.close()
  })

  it('MCP-3: a task created over MCP is equivalent to one created through the API, including its audit entry', async () => {
    // Given the same input, sent once through each door
    const w = await world()
    const input = {
      title: 'Split the invoice parser',
      acceptanceCriteria: [{ text: 'Parsing is separated from validation' }],
      tags: ['billing'],
      priority: 'high',
    }
    const viaApi = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, input)
    ).json()) as Task
    const viaMcp = dataOf<Task>(
      await w.mcp.callTool({ name: 'create_task', arguments: { teamId: w.teamId, ...input } }),
    )

    // When both are read back
    const readApi = await apiJson<Task>(w.ada, `/workspaces/${w.workspaceId}/tasks/${viaApi.id}`)
    const readMcp = await apiJson<Task>(w.ada, `/workspaces/${w.workspaceId}/tasks/${viaMcp.id}`)

    // Then they differ only in identity, and the key comes from the same sequence
    expect(comparable(readMcp)).toEqual(comparable(readApi))
    const sequence = (key: string) => Number(key.split('-').at(-1))
    expect(sequence(readMcp.key)).toBe(sequence(readApi.key) + 1)

    // and each was audited the same way, as the person, not as a tool
    const auditedApi = await auditFor(w.ada, w.workspaceId, viaApi.id)
    const auditedMcp = await auditFor(w.ada, w.workspaceId, viaMcp.id)
    expect(auditedMcp).toHaveLength(1)
    expect(auditedMcp.map(({ action, actorType, actorId }) => ({ action, actorType, actorId }))).toEqual(
      auditedApi.map(({ action, actorType, actorId }) => ({ action, actorType, actorId })),
    )
    expect(auditedMcp[0]!.actorId).toBe(w.ada.userId)
    await w.mcp.close()
  })

  it('MCP-3: an agent updates a task, and a document it created', async () => {
    const w = await world()
    const task = dataOf<Task>(
      await w.mcp.callTool({
        name: 'create_task',
        arguments: { teamId: w.teamId, title: 'Split the invoice parser' },
      }),
    )
    const updated = dataOf<Task>(
      await w.mcp.callTool({
        name: 'update_task',
        arguments: { taskId: task.id, status: 'in_progress', tags: ['billing'] },
      }),
    )

    const document = dataOf<{ id: string; sections: Array<{ key: string; content: string }> }>(
      await w.mcp.callTool({
        name: 'create_document',
        arguments: { teamId: w.teamId, type: 'prd', title: 'Invoice splitting' },
      }),
    )
    const key = document.sections[0]!.key
    const written = dataOf(
      await w.mcp.callTool({
        name: 'update_document',
        arguments: {
          documentId: document.id,
          sections: [{ key, content: 'Finance reconciles invoices by hand.' }],
        },
      }),
    )

    // What the update route answers, which is the task as read back less its sources
    expect(await apiJson(w.ada, `/workspaces/${w.workspaceId}/tasks/${task.id}`)).toMatchObject(updated)
    expect(updated).toMatchObject({ status: 'in_progress', tags: ['billing'] })
    expect(written).toEqual(
      await apiJson(w.ada, `/workspaces/${w.workspaceId}/documents/${document.id}`),
    )
    expect(JSON.stringify(written)).toContain('Finance reconciles invoices by hand.')
    await w.mcp.close()
  })

  it('MCP-3: a token without write:artefacts is refused each write, with the scope named', async () => {
    const w = await world(['read:artefacts'])
    const task = (await (
      await w.ada.post(`/workspaces/${w.workspaceId}/teams/${w.teamId}/tasks`, { title: 'Existing' })
    ).json()) as Task

    const calls = [
      { name: 'create_task', arguments: { teamId: w.teamId, title: 'Nope' } },
      { name: 'update_task', arguments: { taskId: task.id, title: 'Nope' } },
      { name: 'create_document', arguments: { teamId: w.teamId, type: 'prd', title: 'Nope' } },
      { name: 'add_comment', arguments: { documentId: 'any', quote: 'Nope', body: 'Nope' } },
      { name: 'link_artefacts', arguments: { taskId: task.id, toType: 'task', toId: task.id } },
      {
        name: 'report_pr',
        arguments: { taskId: task.id, url: 'https://github.com/acme/widgets/pull/1', status: 'open' },
      },
    ]
    for (const call of calls) {
      const result = await w.mcp.callTool(call)
      expect((result as ToolResult).isError, call.name).toBe(true)
      expect(textOf(result), call.name).toContain('write:artefacts')
    }
    expect((await tasksOf(w.ada, w.workspaceId, w.teamId)).map((t) => t.title)).toEqual(['Existing'])
    await w.mcp.close()
  })

  it('MCP-3: retried creates with the same idempotency key produce one artefact', async () => {
    // Given a create that the agent is unsure went through
    const w = await world()
    const call = {
      name: 'create_task',
      arguments: { teamId: w.teamId, title: 'Split the invoice parser', idempotencyKey: 'agent-run-7:task-1' },
    }

    // When it is sent again with the same key
    const first = dataOf<Task>(await w.mcp.callTool(call))
    const second = dataOf<Task>(await w.mcp.callTool(call))

    // Then exactly one task exists, and the retry is answered with the original
    expect(second).toEqual(first)
    expect(await tasksOf(w.ada, w.workspaceId, w.teamId)).toHaveLength(1)

    // and a different key is a different task
    const third = dataOf<Task>(
      await w.mcp.callTool({ ...call, arguments: { ...call.arguments, idempotencyKey: 'agent-run-7:task-2' } }),
    )
    expect(third.id).not.toBe(first.id)
    await w.mcp.close()
  })

  it('MCP-3: a key reused for a different request is refused rather than answered with the wrong artefact', async () => {
    const w = await world()
    await w.mcp.callTool({
      name: 'create_task',
      arguments: { teamId: w.teamId, title: 'First', idempotencyKey: 'reused' },
    })

    const reused = await w.mcp.callTool({
      name: 'create_task',
      arguments: { teamId: w.teamId, title: 'Second', idempotencyKey: 'reused' },
    })

    expect((reused as ToolResult).isError).toBe(true)
    expect(textOf(reused)).toMatch(/idempotency/i)
    expect((await tasksOf(w.ada, w.workspaceId, w.teamId)).map((t) => t.title)).toEqual(['First'])
    await w.mcp.close()
  })

  it('MCP-3: malformed input names the offending field, and nothing is written', async () => {
    const w = await world()

    const missing = await w.mcp.callTool({ name: 'create_task', arguments: { teamId: w.teamId } })
    const wrongType = await w.mcp.callTool({
      name: 'create_task',
      arguments: { teamId: w.teamId, title: 'Fine', priority: 'whenever' },
    })
    const unknown = await w.mcp.callTool({
      name: 'create_task',
      arguments: { teamId: w.teamId, title: 'Fine', estimate: 3 },
    })

    expect(textOf(missing)).toContain('title')
    expect(textOf(wrongType)).toContain('priority')
    expect(textOf(unknown)).toContain('estimate')
    for (const result of [missing, wrongType, unknown]) {
      expect((result as ToolResult).isError).toBe(true)
    }
    expect(await tasksOf(w.ada, w.workspaceId, w.teamId)).toEqual([])
    await w.mcp.close()
  })
})

/**
 * The HTTP half of AC4. The tools pass their key to the API as an
 * `Idempotency-Key` header (architecture.md §19), so a script calling the API
 * directly gets the same protection an agent does.
 */
describe('MCP-3 Idempotency-Key on the API', () => {
  let db: IsolatedDatabase
  let client: TestClient

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    const mailer = createRecordingMailer()
    client = createTestClient(createApp({ dbConfig: db.config, mailer, baseUrl: ISSUER }), mailer)
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  async function setup() {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Retries')
    const [team] = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    const create = (title: string, key: string) =>
      ada.request(`/workspaces/${workspace.id}/teams/${team!.id}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ title }),
      })
    return { ada, workspaceId: workspace.id, teamId: team!.id, create }
  }

  it('MCP-3: a retried POST with the same Idempotency-Key replays the original response', async () => {
    const s = await setup()

    const first = await s.create('Once', 'k-1')
    const second = await s.create('Once', 'k-1')

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.headers.get('idempotent-replayed')).toBe('true')
    expect(await second.json()).toEqual(await first.json())
    const tasks = (await (
      await s.ada.get(`/workspaces/${s.workspaceId}/teams/${s.teamId}/tasks`)
    ).json()) as unknown[]
    expect(tasks).toHaveLength(1)
  })

  it('MCP-3: the same Idempotency-Key from another user is a different request', async () => {
    const s = await setup()
    const grace = await client.memberWithRole(s.ada, s.workspaceId, 'member')
    await s.create('Ada’s', 'shared-key')

    const graces = await grace.request(`/workspaces/${s.workspaceId}/teams/${s.teamId}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'shared-key' },
      body: JSON.stringify({ title: 'Grace’s' }),
    })

    expect(graces.status).toBe(201)
    expect(((await graces.json()) as Task).title).toBe('Grace’s')
  })

  it('MCP-3: a refused request is not remembered, so correcting it and retrying works', async () => {
    const s = await setup()

    const refused = await s.create('', 'k-fix')
    const corrected = await s.create('Fixed', 'k-fix')

    expect(refused.status).toBe(400)
    expect(corrected.status).toBe(201)
  })
})
