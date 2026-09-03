import { writeFileSync } from 'node:fs'
import { createKeyring, parseMasterKey } from '@chorus/core'
import { createCredentialStore } from '@chorus/connectors'
import { configFromEnv } from '@chorus/db'
import { createIndexer } from '@chorus/indexer'
import { createOpenAiCompatibleProvider, routerConfigFromEnv } from '@chorus/llm'
import { createQueue, redisConfigFromEnv } from '@chorus/queue'
import { createGitRepositoryAccess } from './access.js'
import { createWorker } from './worker.js'

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

async function main(): Promise<void> {
  const dbConfig = configFromEnv()
  const queue = createQueue(redisConfigFromEnv())

  // Fails at boot naming the missing tier (ADR-0015), rather than at the first
  // embedding call with a stack trace.
  const models = routerConfigFromEnv()
  const embedModel = models.embed[0]!.ref

  const provider = createOpenAiCompatibleProvider({
    baseUrl: required('CHORUS_MODEL_BASE_URL'),
    ...(process.env.CHORUS_MODEL_API_KEY
      ? { apiKey: process.env.CHORUS_MODEL_API_KEY }
      : {}),
  })

  const indexer = await createIndexer(dbConfig, {
    embed: (texts) => provider.embed(texts, embedModel),
    embeddingModel: embedModel.model,
  })

  const credentials = createCredentialStore(
    dbConfig,
    createKeyring(masterKeys()),
    masterKeys()[0]!,
  )

  const worker = await createWorker({
    queue,
    dbConfig,
    indexer,
    access: createGitRepositoryAccess({ credentials }),
  })

  const beat = setInterval(() => {
    writeFileSync(HEARTBEAT, new Date().toISOString(), 'utf8')
  }, 5_000)
  writeFileSync(HEARTBEAT, new Date().toISOString(), 'utf8')

  console.warn(
    JSON.stringify({ level: 'info', message: 'worker started', queues: worker.queues }),
  )

  const shutdown = async (signal: string): Promise<void> => {
    console.warn(JSON.stringify({ level: 'info', message: 'worker stopping', signal }))
    clearInterval(beat)
    // Awaited: an in-flight job that is killed mid-write is the case NFR-6's
    // crash tests exist for, and a clean stop is the cheapest way to avoid it.
    await worker.stop()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

await main()
