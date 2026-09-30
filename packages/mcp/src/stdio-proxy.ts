import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

/**
 * The stdio wrapper's two halves (MCP-1 AC4, architecture.md §14).
 *
 * `chorus-mcp` is for clients that prefer to launch a local process. It is a
 * pipe between that process's standard streams and the API's HTTP endpoint,
 * and deliberately nothing more: every capability, permission and answer comes
 * from the endpoint. A wrapper that interpreted messages would be a second
 * server, and the second server is the one that drifts (#85).
 */

export interface WrapperConfig {
  readonly url: URL
  readonly token: string
}

/**
 * What the wrapper is configured with, and all it holds (AC4).
 *
 * A URL and one token, both from the environment the client launches it
 * with. It reads no files and no other credential, so what it can reach is
 * exactly what that token can reach through HTTP.
 */
export function wrapperConfig(env: Readonly<Record<string, string | undefined>>): WrapperConfig {
  const rawUrl = env.CHORUS_MCP_URL?.trim()
  const token = env.CHORUS_MCP_TOKEN?.trim()

  if (!rawUrl) {
    throw new Error(
      'CHORUS_MCP_URL is required: the Chorus MCP endpoint, e.g. https://chorus.example.com/mcp',
    )
  }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`CHORUS_MCP_URL is not a URL: ${rawUrl}`)
  }
  if (!token) {
    throw new Error(
      'CHORUS_MCP_TOKEN is required: an OAuth access token, or a personal API token ' +
        'when CHORUS_MCP_URL is a /workspaces/{workspaceId}/mcp address',
    )
  }
  return { url, token }
}

/**
 * Joins a local transport to a remote one, message for message.
 *
 * Either side closing closes the other: a local client that has gone should
 * end its session at the server rather than leave it to time out, and a server
 * that has gone should not leave a client waiting on a pipe that leads nowhere.
 */
export async function proxy(local: Transport, remote: Transport): Promise<void> {
  let closing = false
  const closeBoth = async () => {
    if (closing) return
    closing = true
    await Promise.allSettled([local.close(), remote.close()])
  }

  local.onmessage = (message) => {
    remote.send(message).catch((error: unknown) => local.onerror?.(error as Error))
  }
  remote.onmessage = (message) => {
    local.send(message).catch((error: unknown) => remote.onerror?.(error as Error))
  }
  local.onclose = () => void closeBoth()
  remote.onclose = () => void closeBoth()

  await remote.start()
  await local.start()
}
