import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient, type TestClient } from '@chorus/testing'

/**
 * CODE-1 AC4 (#170 AC1–AC3) and MCP-3 AC6 — the `before_coding_job` gate on a
 * launch no person clicked.
 *
 * `start_coding_job` is the first such launch: an agent holding a token asks
 * for a job, and nobody pressed a button. Under `ask` the job is created but
 * held, a checkpoint is raised, and the decision on it either releases that
 * same job or cancels it. A person launching from the product is not asked:
 * the click was the approval, and a gate that asks the person who just asked
 * teaches them to approve without reading.
 *
 * Which caller is which is decided by the credential, not by anything the
 * caller says about itself: a launch made with a token (an API token or an
 * MCP grant) is agent-initiated, and only an interactive session is a person.
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

interface Job {
  id: string
  status: string
  checkpointId: string | null
}

describe('CODE-1 AC4 and MCP-3 AC6 the agent launch gate', () => {
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

  /** A team with a repository, a task, a policy, and an agent connected with a token. */
  async function world(
    mode: 'ask' | 'auto' | 'never' | undefined = 'ask',
    scopes: string[] = ['read:artefacts', 'write:artefacts', 'run:coding'],
  ) {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Gated launches')
    const [team] = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    const teamId = team!.id

    const [integration] = await db.admin.query<{ id: string }>(
      `INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'github') RETURNING id`,
      [`int${Date.now()}${Math.floor(Math.random() * 1000)}`, workspace.id],
    )
    const linked = await ada.post(`/workspaces/${workspace.id}/teams/${teamId}/repositories`, {
      integrationId: integration!.id,
      provider: 'github',
      fullName: 'acme/widgets',
    })
    expect(linked.status, await linked.clone().text()).toBe(201)

    if (mode) {
      const policy = await ada.request(`/workspaces/${workspace.id}/teams/${teamId}/policies`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ checkpointKind: 'before_coding_job', mode }),
      })
      expect(policy.status, await policy.clone().text()).toBe(200)
    }

    const task = (await (
      await ada.post(`/workspaces/${workspace.id}/teams/${teamId}/tasks`, {
        title: 'Split the invoice parser',
      })
    ).json()) as { id: string }

    const created = await ada.post(`/workspaces/${workspace.id}/tokens`, { name: 'agent', scopes })
    expect(created.status, await created.clone().text()).toBe(201)
    const token = ((await created.json()) as { token: string }).token
    const transport = new StreamableHTTPClientTransport(
      new URL(`${ISSUER}/workspaces/${workspace.id}/mcp`),
      { fetch: fetchFn, requestInit: { headers: { authorization: `Bearer ${token}` } } },
    )
    const mcp = new Client({ name: 'gated-agent', version: '1.0.0' })
    await mcp.connect(asTransport(transport))

    const launchPath = `/workspaces/${workspace.id}/teams/${teamId}/tasks/${task.id}/coding-jobs`
    return { ada, workspaceId: workspace.id, teamId, taskId: task.id, token, mcp, launchPath }
  }

  async function jobsFor(w: Awaited<ReturnType<typeof world>>): Promise<Job[]> {
    const response = await w.ada.get(`/workspaces/${w.workspaceId}/tasks/${w.taskId}/coding-jobs`)
    expect(response.status).toBe(200)
    return (await response.json()) as Job[]
  }

  async function checkpoint(w: Awaited<ReturnType<typeof world>>, id: string) {
    const response = await w.ada.get(`/workspaces/${w.workspaceId}/checkpoints/${id}`)
    expect(response.status, await response.clone().text()).toBe(200)
    return (await response.json()) as { kind: string; status: string; payload: Record<string, unknown> }
  }

  async function decide(w: Awaited<ReturnType<typeof world>>, id: string, decision: string) {
    const response = await w.ada.post(`/workspaces/${w.workspaceId}/checkpoints/${id}/decision`, {
      decision,
    })
    expect(response.status, await response.clone().text()).toBe(200)
  }

  it('MCP-3: start_coding_job is advertised, needing run:coding', async () => {
    const w = await world()

    const { tools } = await w.mcp.listTools()
    const tool = tools.find((each) => each.name === 'start_coding_job')

    expect(tool, 'start_coding_job is not advertised').toBeDefined()
    expect(tool!.annotations?.readOnlyHint).toBe(false)
    expect(tool!.description).toMatch(/approv/i)
    await w.mcp.close()
  })

  it('CODE-1 AC4: an agent-initiated launch under ask is held at a before_coding_job checkpoint', async () => {
    // Given before_coding_job set to ask for the team
    const w = await world('ask')

    // When an agent starts a job over MCP
    const job = dataOf<Job>(
      await w.mcp.callTool({
        name: 'start_coding_job',
        arguments: { teamId: w.teamId, taskId: w.taskId },
      }),
    )

    // Then the job exists but is not queued for provisioning
    expect(job.status).toBe('awaiting_approval')
    expect(job.checkpointId).toEqual(expect.any(String))
    // and the checkpoint is the one the product raises, showing what it gates
    const gate = await checkpoint(w, job.checkpointId!)
    expect(gate).toMatchObject({ kind: 'before_coding_job', status: 'pending' })
    expect(gate.payload).toMatchObject({ jobId: job.id, taskId: w.taskId })
    await w.mcp.close()
  })

  it('CODE-1 AC4: approving the checkpoint continues the same job rather than starting a second', async () => {
    const w = await world('ask')
    const held = dataOf<Job>(
      await w.mcp.callTool({ name: 'start_coding_job', arguments: { teamId: w.teamId, taskId: w.taskId } }),
    )

    await decide(w, held.checkpointId!, 'approve')

    const jobs = await jobsFor(w)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ id: held.id, status: 'queued' })
    await w.mcp.close()
  })

  it('CODE-1 AC4: rejecting the checkpoint cancels the job', async () => {
    const w = await world('ask')
    const held = dataOf<Job>(
      await w.mcp.callTool({ name: 'start_coding_job', arguments: { teamId: w.teamId, taskId: w.taskId } }),
    )

    await decide(w, held.checkpointId!, 'reject')

    expect(await jobsFor(w)).toEqual([expect.objectContaining({ id: held.id, status: 'cancelled' })])
    await w.mcp.close()
  })

  it('CODE-1 AC4: approving a held job that was cancelled meanwhile does not revive it', async () => {
    const w = await world('ask')
    const held = dataOf<Job>(
      await w.mcp.callTool({ name: 'start_coding_job', arguments: { teamId: w.teamId, taskId: w.taskId } }),
    )
    const cancelled = await w.ada.post(`/workspaces/${w.workspaceId}/coding-jobs/${held.id}/cancel`, {})
    expect(cancelled.status, await cancelled.clone().text()).toBe(200)

    await decide(w, held.checkpointId!, 'approve')

    expect(await jobsFor(w)).toEqual([expect.objectContaining({ id: held.id, status: 'cancelled' })])
    await w.mcp.close()
  })

  it('CODE-1 AC4: a held job is the active one, so asking again returns it', async () => {
    const w = await world('ask')
    const call = { name: 'start_coding_job', arguments: { teamId: w.teamId, taskId: w.taskId } }

    const first = dataOf<Job>(await w.mcp.callTool(call))
    const second = dataOf<Job>(await w.mcp.callTool(call))

    expect(second.id).toBe(first.id)
    expect(await jobsFor(w)).toHaveLength(1)
    await w.mcp.close()
  })

  it('CODE-1 AC4: a launch with an API token is agent-initiated too, not only one over MCP', async () => {
    const w = await world('ask')

    const response = await client.bearer(w.token).post(w.launchPath, {})

    expect(response.status, await response.clone().text()).toBe(201)
    expect(((await response.json()) as Job).status).toBe('awaiting_approval')
    await w.mcp.close()
  })

  it("CODE-1 AC4: a person's own launch under ask is not asked about twice", async () => {
    // Given the same policy
    const w = await world('ask')

    // When the person launches from the product
    const response = await w.ada.post(w.launchPath, {})

    // Then the click was the approval: queued, and no checkpoint raised
    expect(response.status, await response.clone().text()).toBe(201)
    expect((await response.json()) as Job).toMatchObject({ status: 'queued', checkpointId: null })
    await w.mcp.close()
  })

  it('CODE-1 AC4: under auto the agent launch is queued, and the gate it passed is recorded', async () => {
    const w = await world('auto')

    const job = dataOf<Job>(
      await w.mcp.callTool({ name: 'start_coding_job', arguments: { teamId: w.teamId, taskId: w.taskId } }),
    )

    expect(job.status).toBe('queued')
    expect(await checkpoint(w, job.checkpointId!)).toMatchObject({
      kind: 'before_coding_job',
      status: 'approved',
    })
    await w.mcp.close()
  })

  it('CODE-1 AC4: under never an agent launch is refused rather than silently run', async () => {
    const w = await world('never')

    const result = await w.mcp.callTool({
      name: 'start_coding_job',
      arguments: { teamId: w.teamId, taskId: w.taskId },
    })

    expect((result as ToolResult).isError).toBe(true)
    expect(textOf(result)).toContain('before_coding_job')
    expect(await jobsFor(w)).toEqual([])
    await w.mcp.close()
  })

  it('MCP-3: a token without run:coding is refused start_coding_job, with the scope named', async () => {
    const w = await world('ask', ['read:artefacts', 'write:artefacts'])

    const result = await w.mcp.callTool({
      name: 'start_coding_job',
      arguments: { teamId: w.teamId, taskId: w.taskId },
    })

    expect((result as ToolResult).isError).toBe(true)
    expect(textOf(result)).toContain('run:coding')
    expect(await jobsFor(w)).toEqual([])
    await w.mcp.close()
  })

  it('WS-4 AC1: over MCP, a member is refused start_coding_job and audited, and a senior member is not', async () => {
    // Given a member and a senior member, each with an agent holding run:coding
    const w = await world('ask')
    const agentOf = async (user: Awaited<ReturnType<TestClient['memberWithRole']>>) => {
      const created = await user.post(`/workspaces/${w.workspaceId}/tokens`, {
        name: 'agent',
        scopes: ['read:artefacts', 'write:artefacts', 'run:coding'],
      })
      expect(created.status, await created.clone().text()).toBe(201)
      const token = ((await created.json()) as { token: string }).token
      const transport = new StreamableHTTPClientTransport(
        new URL(`${ISSUER}/workspaces/${w.workspaceId}/mcp`),
        { fetch: fetchFn, requestInit: { headers: { authorization: `Bearer ${token}` } } },
      )
      const mcp = new Client({ name: 'role-agent', version: '1.0.0' })
      await mcp.connect(asTransport(transport))
      return mcp
    }
    const member = await client.memberWithRole(w.ada, w.workspaceId, 'member')
    const senior = await client.memberWithRole(w.ada, w.workspaceId, 'senior_member')
    const call = { name: 'start_coding_job', arguments: { teamId: w.teamId, taskId: w.taskId } }

    // When the member's agent starts a job
    const memberAgent = await agentOf(member)
    const refused = await memberAgent.callTool(call)

    // Then it is refused for the role, nothing is created, and the refusal is audited
    expect((refused as ToolResult).isError).toBe(true)
    expect(textOf(refused)).toMatch(/^Not permitted/)
    expect(await jobsFor(w)).toEqual([])
    const [denial] = await db.admin.query<{ actor_id: string; after: Record<string, unknown> }>(
      `SELECT actor_id, after FROM audit_events
        WHERE workspace_id = $1 AND action = 'access.denied' ORDER BY at DESC LIMIT 1`,
      [w.workspaceId],
    )
    expect(denial).toMatchObject({ actor_id: member.userId, after: { required: 'senior_member', held: 'member' } })

    // And the same call from the senior member's agent is accepted (and held at the gate)
    const seniorAgent = await agentOf(senior)
    const accepted = dataOf<Job>(await seniorAgent.callTool(call))
    expect(accepted.status).toBe('awaiting_approval')

    await memberAgent.close()
    await seniorAgent.close()
    await w.mcp.close()
  })
})
