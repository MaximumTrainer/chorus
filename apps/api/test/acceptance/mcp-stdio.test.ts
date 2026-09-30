import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import { createRecordingMailer, createTestClient } from '@chorus/testing'

/**
 * MCP-1 AC4 — the stdio wrapper is the HTTP endpoint, reached another way.
 *
 * The wrapper is launched exactly as a client would launch it, as a child
 * process speaking MCP on its standard streams, and pointed at a real listening
 * API. The same operations are then made over both transports and compared
 * whole: a wrapper that answers differently from the endpoint it fronts is two
 * servers, and the second one is the one nobody tests.
 */

const WRAPPER = fileURLToPath(new URL('../../../../packages/mcp/src/bin/chorus-mcp.ts', import.meta.url))
const TSX = fileURLToPath(new URL('../../../../node_modules/.bin/tsx', import.meta.url))

/** See mcp.test.ts: the SDK's two types disagree only under exactOptionalPropertyTypes. */
const asTransport = (transport: unknown): Transport => transport as Transport

describe('MCP-1 stdio wrapper', () => {
  let db: IsolatedDatabase
  let server: ServerType
  let baseUrl: string
  let workspaceId: string
  let token: string

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    const mailer = createRecordingMailer()
    // Assigned once the port is known, because the issuer it advertises must
    // be the address the wrapper actually reaches.
    const holder: { app?: ReturnType<typeof createApp> } = {}
    // A real socket, because the wrapper is a separate process and reaches the
    // API the way a deployment's users would: over HTTP.
    await new Promise<void>((ready) => {
      server = serve({ fetch: (request) => holder.app!.fetch(request), port: 0 }, () => ready())
    })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const app = createApp({ dbConfig: db.config, mailer, baseUrl })
    holder.app = app
    const client = createTestClient(app, mailer)

    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Stdio')
    workspaceId = workspace.id
    const created = await ada.post(`/workspaces/${workspace.id}/tokens`, {
      name: 'stdio-wrapper',
      scopes: ['read:artefacts'],
    })
    token = ((await created.json()) as { token: string }).token
  }, 120_000)

  afterAll(async () => {
    await new Promise<void>((done) => server?.close(() => done()))
    await db?.drop()
  })

  async function operations(mcp: Client) {
    return {
      server: mcp.getServerVersion(),
      capabilities: mcp.getServerCapabilities(),
      tools: await mcp.listTools(),
    }
  }

  it('MCP-1: the stdio wrapper produces identical results to the HTTP transport', async () => {
    const url = `${baseUrl}/workspaces/${workspaceId}/mcp`

    const http = new Client({ name: 'mcp-1-http', version: '1.0.0' })
    await http.connect(
      asTransport(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      ),
    )

    const stdio = new Client({ name: 'mcp-1-stdio', version: '1.0.0' })
    await stdio.connect(
      asTransport(
        new StdioClientTransport({
          command: TSX,
          args: [WRAPPER],
          // Only what a user would configure. The parent's environment is not
          // inherited, so nothing the test process holds can leak in.
          env: { PATH: process.env.PATH ?? '', CHORUS_MCP_URL: url, CHORUS_MCP_TOKEN: token },
          stderr: 'pipe',
        }),
      ),
    )

    expect(await operations(stdio)).toEqual(await operations(http))

    await stdio.close()
    await http.close()
  }, 60_000)

  it('MCP-1: the stdio wrapper refuses to start without a URL and a token, and says which is missing', async () => {
    const transport = new StdioClientTransport({
      command: TSX,
      args: [WRAPPER],
      env: { PATH: process.env.PATH ?? '', CHORUS_MCP_URL: `${baseUrl}/mcp` },
      stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const mcp = new Client({ name: 'mcp-1-stdio', version: '1.0.0' })
    await expect(mcp.connect(asTransport(transport))).rejects.toThrow()
    expect(stderr).toContain('CHORUS_MCP_TOKEN')
  }, 60_000)
})
