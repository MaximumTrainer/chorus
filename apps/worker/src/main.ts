import { writeFileSync } from 'node:fs'
import { ConfigurationError, createKeyring, parseMasterKey } from '@chorus/core'
import {
  createConfluenceConnector,
  createCredentialStore,
  createJiraConnector,
  createLinearConnector,
  type Connector,
  type IntegrationRecord,
} from '@chorus/connectors'
import { createEntityStore, createScopeMemberships } from '@chorus/brain'
import { configFromEnv } from '@chorus/db'
import { builtInWorkflows } from '@chorus/agent'
import { createIndexer } from '@chorus/indexer'
import { providersFromEnv, routerConfigFromEnv } from '@chorus/llm'
import { createQueue, redisConfigFromEnv } from '@chorus/queue'
import { initTelemetry, shutdownTelemetry } from '@chorus/telemetry'
import { createGitRepositoryAccess } from './access.js'
import { createWorker } from './worker.js'
import { createSyncScheduler } from './sync-scheduler.js'

/**
 * The worker process entrypoint (architecture.md §6).
 *
 * No HTTP surface: everything it does arrives through the queue. Health is a
 * heartbeat file its own loop refreshes, because a container that is running
 * while its consumers have quietly died is otherwise indistinguishable from a
 * healthy one — and that is the failure that leaves a queue filling forever.
 */

const HEARTBEAT = process.env.CHORUS_WORKER_HEARTBEAT ?? '/tmp/chorus-worker-alive'

/** A required setting, named when it is absent. */
function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(`${name} is required`)
  }
  return value
}

/**
 * The master keys, current first (INT-1 AC1).
 *
 * A list rather than one key so a rotation can be in progress: the current key
 * wraps new data keys while the previous one is still needed to unwrap the rows
 * that have not been rewrapped yet.
 */
function masterKeys() {
  const current = parseMasterKey(required('CHORUS_MASTER_KEY_ID'), required('CHORUS_MASTER_KEY'))
  const previousId = process.env.CHORUS_MASTER_KEY_PREVIOUS_ID
  const previous = process.env.CHORUS_MASTER_KEY_PREVIOUS
  return previousId && previous
    ? [current, parseMasterKey(previousId, previous)]
    : [current]
}

/** A positive whole number from the environment, or the default. */
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number`)
  return value
}

/**
 * An Atlassian integration's API base (BRAIN-1). Each Atlassian site has its own
 * cloud id, carried on the integration's config; without it the site is unknown
 * and the sync fails naming what is missing, rather than calling the wrong one.
 * Called without an integration (pure mapping), no base is needed.
 */
function atlassianApi(product: 'confluence' | 'jira', integration?: IntegrationRecord): { apiUrl?: string } {
  if (!integration) return {}
  const cloudId = integration.config.cloudId
  if (typeof cloudId !== 'string' || cloudId.trim() === '') {
    throw new ConfigurationError(
      `The ${product} integration ${integration.id} has no config.cloudId, so its Atlassian site is unknown.`,
    )
  }
  return { apiUrl: `https://api.atlassian.com/ex/${product}/${cloudId}` }
}

async function main(): Promise<void> {
  // Before the consumers register: a job picked up by a worker whose provider
  // is not yet running loses the one span that joins it to its request.
  initTelemetry({ serviceName: 'chorus-worker' })

  // Before anything else that could accept work (AGENT-1 AC1). A definition
  // naming a tool that is not registered or a prompt somebody renamed is a
  // problem the process should die of at boot, not one a run discovers at step
  // four having already done steps one to three — some of which may have
  // written something.
  const workflows = builtInWorkflows({
    allowedHosts: (process.env.CHORUS_TOOL_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter((host) => host !== ''),
  })

  const dbConfig = configFromEnv()
  const queue = createQueue(redisConfigFromEnv())

  // Two different situations, deliberately handled differently (ADR-0015).
  //
  // A *misconfigured* deployment — some tiers set, one missing or undersized —
  // is a mistake, and boot is the cheapest moment to find it. A *not yet
  // configured* deployment is not a mistake: it is `docker compose up` on a
  // fresh host, which NFR-1 requires to reach a working system. Refusing to
  // start there would leave an operator with a crash-looping container instead
  // of a system they can log into and configure.
  //
  // So: validate eagerly when configuration exists, and defer when it does not.
  // Work that needs a model then fails with the missing setting named, and
  // lands on the queue's failed set where "what failed and why" is answerable.
  const configured = Boolean(process.env.CHORUS_MODEL_TIERS?.trim())
  const models = configured ? routerConfigFromEnv() : undefined

  if (!configured) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message:
          'no model configuration: indexing jobs will fail until CHORUS_MODEL_TIERS ' +
          'and CHORUS_MODEL_BASE_URL are set (see deploy/model-tiers.example.json)',
      }),
    )
  }

  const indexer = await createIndexer(dbConfig, {
    embed: async (texts) => {
      if (!models) {
        throw new ConfigurationError(
          'Cannot embed: CHORUS_MODEL_TIERS and CHORUS_MODEL_BASE_URL are not set. ' +
            'See deploy/model-tiers.example.json.',
        )
      }
      const embedModel = models.embed[0]!.ref
      // Through the registry, so the `provider` half of the configured tier is
      // what decides the client — the same dispatch every model call uses.
      return providersFromEnv().embed(texts, embedModel)
    },
    embeddingModel: models?.embed[0]!.ref.model ?? 'unconfigured',
  })

  const credentials = createCredentialStore(
    dbConfig,
    createKeyring(masterKeys()),
    masterKeys()[0]!,
  )

  // The Atlassian OAuth app refreshes Atlassian integrations' tokens.
  const atlassianApp = {
    ...(process.env.CHORUS_ATLASSIAN_CLIENT_ID ? { clientId: process.env.CHORUS_ATLASSIAN_CLIENT_ID } : {}),
    ...(process.env.CHORUS_ATLASSIAN_CLIENT_SECRET ? { clientSecret: process.env.CHORUS_ATLASSIAN_CLIENT_SECRET } : {}),
  }
  // The sources this worker ingests from on a schedule (BRAIN-1), by integration kind.
  const sources: Record<string, (integration?: IntegrationRecord) => Connector> = {
    confluence: (integration) => createConfluenceConnector({ ...atlassianApp, ...atlassianApi('confluence', integration) }),
    jira: (integration) => createJiraConnector({ ...atlassianApp, ...atlassianApi('jira', integration) }),
    linear: () => createLinearConnector(),
  }

  const worker = await createWorker({
    queue,
    dbConfig,
    indexer,
    access: createGitRepositoryAccess({ credentials }),
    sync: {
      credentials,
      connectors: sources,
      entities: createEntityStore(dbConfig),
      memberships: createScopeMemberships(dbConfig),
    },
  })

  // Ticks are frequent and cheap; the interval is what bounds how often each
  // source is asked, because every tick within one interval collapses into a
  // single sync per integration.
  const scheduler = createSyncScheduler({
    dbConfig,
    queue,
    kinds: Object.keys(sources),
    intervalMs: positiveInt('CHORUS_SYNC_INTERVAL_MINUTES', 15) * 60_000,
  })
  const tick = (): void => {
    scheduler.tick(new Date()).catch((error: unknown) => {
      console.warn(
        JSON.stringify({ level: 'error', message: 'sync schedule tick failed', error: (error as Error).message }),
      )
    })
  }
  const ticker = setInterval(tick, positiveInt('CHORUS_SYNC_TICK_SECONDS', 60) * 1_000)
  tick()

  const beat = setInterval(() => {
    writeFileSync(HEARTBEAT, new Date().toISOString(), 'utf8')
  }, 5_000)
  writeFileSync(HEARTBEAT, new Date().toISOString(), 'utf8')

  console.warn(
    JSON.stringify({
      level: 'info',
      message: 'worker started',
      queues: worker.queues,
      workflows: workflows.names(),
    }),
  )

  const shutdown = async (signal: string): Promise<void> => {
    console.warn(JSON.stringify({ level: 'info', message: 'worker stopping', signal }))
    clearInterval(beat)
    clearInterval(ticker)
    // Flushed before exit: a batch of spans still in memory when the process
    // ends is a trace that stops mid-run for no visible reason.
    await shutdownTelemetry()
    // Awaited: an in-flight job that is killed mid-write is the case NFR-6's
    // crash tests exist for, and a clean stop is the cheapest way to avoid it.
    await worker.stop()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

await main()
