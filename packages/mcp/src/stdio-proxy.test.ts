import { describe, it, expect } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { proxy, wrapperConfig } from './stdio-proxy.js'

/**
 * MCP-1 AC4 — the stdio wrapper holds a URL and a token, and forwards.
 *
 * It must not accumulate logic of its own, or the two transports diverge
 * (#85's implementation notes). So what is tested here is that it is a pipe:
 * every message in either direction arrives unchanged, and nothing else does.
 */
describe('MCP-1 stdio wrapper', () => {
  it('MCP-1: configuration is a URL and a token, both required, each named when missing', () => {
    expect(
      wrapperConfig({ CHORUS_MCP_URL: 'https://chorus.example/mcp', CHORUS_MCP_TOKEN: 'chorus_at_x' }),
    ).toEqual({ url: new URL('https://chorus.example/mcp'), token: 'chorus_at_x' })

    expect(() => wrapperConfig({ CHORUS_MCP_URL: 'https://chorus.example/mcp' })).toThrow(
      /CHORUS_MCP_TOKEN/,
    )
    expect(() => wrapperConfig({ CHORUS_MCP_TOKEN: 't' })).toThrow(/CHORUS_MCP_URL/)
    expect(() => wrapperConfig({ CHORUS_MCP_URL: 'not a url', CHORUS_MCP_TOKEN: 't' })).toThrow(
      /CHORUS_MCP_URL/,
    )
  })

  it('MCP-1: messages cross in both directions unchanged', async () => {
    const [client, local] = InMemoryTransport.createLinkedPair()
    const [remote, server] = InMemoryTransport.createLinkedPair()

    const atServer: JSONRPCMessage[] = []
    const atClient: JSONRPCMessage[] = []
    server.onmessage = (message) => {
      atServer.push(message)
    }
    client.onmessage = (message) => {
      atClient.push(message)
    }
    await server.start()
    await client.start()

    await proxy(local, remote)

    const request: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    const reply: JSONRPCMessage = { jsonrpc: '2.0', id: 1, result: { tools: [] } }
    await client.send(request)
    await server.send(reply)

    expect(atServer).toEqual([request])
    expect(atClient).toEqual([reply])
  })

  it('MCP-1: when the local client goes away, the remote session is closed too', async () => {
    const [client, local] = InMemoryTransport.createLinkedPair()
    const [remote, server] = InMemoryTransport.createLinkedPair()
    let serverClosed = false
    server.onclose = () => {
      serverClosed = true
    }
    await server.start()
    await client.start()
    await proxy(local, remote)

    await client.close()

    expect(serverClosed).toBe(true)
  })
})
