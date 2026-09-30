#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { proxy, wrapperConfig } from '../stdio-proxy.js'

/**
 * `chorus-mcp` — the Chorus MCP server over stdio (MCP-1 AC4).
 *
 *   CHORUS_MCP_URL=https://chorus.example.com/mcp CHORUS_MCP_TOKEN=… chorus-mcp
 *
 * Standard output carries the protocol and nothing else, so every diagnostic
 * goes to standard error: a stray line on stdout is a message the client
 * cannot parse, and it closes the connection without saying why.
 */

let config
try {
  config = wrapperConfig(process.env)
} catch (error) {
  process.stderr.write(`chorus-mcp: ${(error as Error).message}\n`)
  process.exit(2)
}

const remote = new StreamableHTTPClientTransport(config.url, {
  requestInit: { headers: { authorization: `Bearer ${config.token}` } },
})
const local = new StdioServerTransport()

// The session is ended at the server when the client goes, rather than left to
// expire: an abandoned session is state the server holds for nobody.
process.stdin.on('end', () => {
  void remote
    .terminateSession()
    .catch(() => undefined)
    .finally(() => process.exit(0))
})

remote.onerror = (error) => process.stderr.write(`chorus-mcp: ${error.message}\n`)

// See the acceptance suite: the SDK's two transport types disagree only under
// this repository's exactOptionalPropertyTypes.
await proxy(local as unknown as Transport, remote as unknown as Transport)
