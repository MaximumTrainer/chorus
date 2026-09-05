import { configFromEnv } from '@chorus/db'
import { initTelemetry, shutdownTelemetry } from '@chorus/telemetry'
import { createCollabServer } from './server.js'

/**
 * The collaboration process entrypoint (DOC-2, architecture.md §5.1).
 *
 * A third process rather than a route on the API, because a WebSocket holding a
 * document in memory for every open editor has a completely different lifetime
 * and memory profile from a request handler. Sharing a process would mean the
 * API's replica count being decided by how many documents happen to be open.
 */
const PORT = Number(process.env.CHORUS_COLLAB_PORT ?? 1234)

async function main(): Promise<void> {
  initTelemetry({ serviceName: 'chorus-collab' })

  const server = await createCollabServer({ dbConfig: configFromEnv(), port: PORT })

  console.warn(
    JSON.stringify({ level: 'info', message: 'collaboration server started', port: server.port }),
  )

  const shutdown = async (signal: string): Promise<void> => {
    console.warn(JSON.stringify({ level: 'info', message: 'collaboration stopping', signal }))
    // Stopped before the process ends, so Hocuspocus writes the state of every
    // open document. Exiting with an unsaved document in memory loses exactly
    // the edits somebody made in the last few seconds — the ones they remember
    // making.
    await server.stop()
    await shutdownTelemetry()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

await main()
