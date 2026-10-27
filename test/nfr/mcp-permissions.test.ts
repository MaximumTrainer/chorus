import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApp, mcpToolRoute, routeTable, type RouteDefinition } from '@chorus/api'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { MCP_TOOLS, ROLES, SCOPES, atLeast, type McpToolName, type Role } from '@chorus/core'
import { createRecordingMailer, createTestClient, type SignedInUser, type TestClient } from '@chorus/testing'
import { connectMcp, textOf } from '../support/mcp-wire.js'

/**
 * MCP-5 AC1 — exhaustive permission parity between MCP and the API.
 *
 * MCP is a second front door to everything, and nobody clicks through it, so a
 * gap between the two is a privilege escalation nobody would notice. Parity is
 * therefore asserted, not intended: every tool, for every role, with a token
 * that has every scope and with one that lacks exactly what the tool's route
 * declares. The permitted set must be the same through both doors, and both
 * must agree with the route's declaration.
 *
 * Generated from the tool registry and the route table, so a new tool joins
 * the suite by existing. A tool needs a sample argument set here, and the
 * first test fails until it has one: the same mechanism as WS-4 AC4, which is
 * what makes "no tool exempted" true by construction.
 */

const ROUTES = routeTable()
const TOOLS = Object.keys(MCP_TOOLS) as McpToolName[]

/** Arguments each tool accepts, so the call reaches authorisation rather than stopping at validation. */
function sampleArgs(teamId: string): Record<string, Record<string, unknown>> {
  return {
    list_tasks: { teamId },
    get_task: { taskId: 'no-such-task' },
    list_documents: { teamId },
    get_document: { documentId: 'no-such-document' },
    get_session: { sessionId: 'no-such-session' },
    get_coding_job: { jobId: 'no-such-job' },
    create_task: { teamId, title: 'Parity' },
    update_task: { taskId: 'no-such-task', title: 'Parity' },
    create_document: { teamId, type: 'prd', title: 'Parity' },
    update_document: { documentId: 'no-such-document', sections: [{ key: 'k', content: 'x' }] },
    add_comment: { documentId: 'no-such-document', quote: 'x', body: 'Parity' },
    link_artefacts: { taskId: 'no-such-task', toType: 'task', toId: 'no-such-task' },
    report_pr: { taskId: 'no-such-task', url: 'https://github.com/acme/widgets/pull/1', status: 'open' },
    start_coding_job: { teamId, taskId: 'no-such-task' },
    search: { teamId, query: 'parity' },
  }
}

/** The declaration in the route table that serves a concrete path. */
function declarationFor(method: string, path: string): RouteDefinition | undefined {
  return ROUTES.find((definition) => {
    if (definition.method !== method) return false
    const pattern = new RegExp(`^${definition.path.replace(/:[A-Za-z]+/g, '[^/]+')}$`)
    return pattern.test(path)
  })
}

describe('MCP-5 permission parity', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let app: ReturnType<typeof createApp>
  let workspaceId: string
  let teamId: string
  const callers = new Map<Role, SignedInUser>()

  const send = async (path: string, init: RequestInit) => app.request(path, init)

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    const mailer = createRecordingMailer()
    app = createApp({ dbConfig: db.config, mailer })
    client = createTestClient(app, mailer)

    const owner = await client.signedInUser()
    const workspace = await owner.createWorkspace('MCP parity')
    workspaceId = workspace.id
    callers.set('owner', owner)
    const [team] = (await (await owner.get(`/workspaces/${workspaceId}/teams`)).json()) as Array<{ id: string }>
    teamId = team!.id
    for (const role of ROLES) {
      if (role !== 'owner') callers.set(role, await client.memberWithRole(owner, workspaceId, role))
    }
  }, 180_000)

  afterAll(async () => {
    await db?.drop()
  })

  async function tokenFor(role: Role, scopes: readonly string[]): Promise<string> {
    const created = await callers.get(role)!.post(`/workspaces/${workspaceId}/tokens`, {
      name: `parity-${role}`,
      scopes,
    })
    expect(created.status, await created.clone().text()).toBe(201)
    return ((await created.json()) as { token: string }).token
  }

  it('MCP-5 AC1: every tool has a parity case, and every case is a tool', () => {
    expect(Object.keys(sampleArgs('t')).sort()).toEqual([...TOOLS].sort())
  })

  it('MCP-5 AC1: every tool is answered by a route the route table declares', () => {
    for (const tool of TOOLS) {
      const args = sampleArgs('team')[tool]!
      const { method, path } = mcpToolRoute(tool, 'workspace', args)
      expect(declarationFor(method, path), `${tool} → ${method} ${path}`).toBeDefined()
    }
  })

  const cases = TOOLS.flatMap((tool) =>
    ROLES.flatMap((role) =>
      (['every scope', 'without its scope'] as const).map((grant) => [tool, role, grant] as const),
    ),
  )

  it.each(cases)(
    'MCP-5 AC1: %s for %s with a token holding %s is permitted over MCP exactly as through the API',
    async (tool, role, grant) => {
      const args = sampleArgs(teamId)[tool]!
      const { method, path } = mcpToolRoute(tool, workspaceId, args)
      const declaration = declarationFor(method, path)!
      const auth = declaration.auth as { kind: 'workspace'; role: Role; scopes: readonly string[] }
      const scopes = grant === 'every scope' ? SCOPES : SCOPES.filter((scope) => !auth.scopes.includes(scope))
      const token = await tokenFor(role, scopes)

      // Through the API, with the same credential
      const bearer = client.bearer(token)
      const viaApi =
        method === 'GET'
          ? await bearer.get(path)
          : method === 'PATCH'
            ? await bearer.patch(path, {})
            : await bearer.post(path, {})
      const apiRefused = viaApi.status === 401 || viaApi.status === 403

      // Over MCP
      const mcp = await connectMcp(send, workspaceId, { authorization: `Bearer ${token}` })
      const result = await mcp.callTool(tool, args)
      const mcpRefused = result.isError === true && /^Not (permitted|authenticated)/.test(textOf(result))

      // The declaration's own verdict, which both doors must reach
      const declared =
        atLeast(role, auth.role) && auth.scopes.every((scope) => scopes.includes(scope as never))

      expect(apiRefused, `API: ${viaApi.status} ${await viaApi.clone().text()}`).toBe(!declared)
      expect(mcpRefused, `MCP: ${textOf(result)}`).toBe(apiRefused)
    },
  )
})
