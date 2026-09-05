import { serve } from '@hono/node-server'
import { configFromEnv } from '@chorus/db'
import { initTelemetry } from '@chorus/telemetry'
import { createApp } from './app.js'

/**
 * The API process entrypoint (architecture.md §6).
 *
 * Stateless: everything long-running is enqueued. The only thing this file
 * decides is how the process is wired to its environment and how it stops.
 */

// Before anything else: a span cannot be recorded by a provider that does not
// exist yet, so late initialisation silently loses the first requests.
initTelemetry({ serviceName: 'chorus-api' })

const port = Number(process.env.CHORUS_PORT ?? 3000)

const app = createApp({
  dbConfig: configFromEnv(),
  baseUrl: process.env.CHORUS_BASE_URL ?? `http://localhost:${port}`,
  // Empty unless a deployment names them. Behind one reverse proxy the web app
  // shares this origin and needs none; on separate hosts it does, and guessing
  // would make every authenticated route callable by any page.
  webOrigins: (process.env.CHORUS_WEB_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== ''),
})

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.warn(JSON.stringify({ level: 'info', message: 'api listening', port: info.port }))
})

const shutdown = (signal: string): void => {
  console.warn(JSON.stringify({ level: 'info', message: 'api stopping', signal }))
  // In-flight requests are allowed to finish. A load balancer has already been
  // told we are unready by the time this arrives, so the window is short and
  // dropping a request inside it would be gratuitous.
  server.close(() => process.exit(0))
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
