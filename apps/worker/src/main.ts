import { writeFileSync } from 'node:fs'
import { configFromEnv } from '@chorus/db'
import { createIndexer } from '@chorus/indexer'
import { createQueue, redisConfigFromEnv } from '@chorus/queue'
import { createWorker } from './worker.js'

/**
 * The worker process entrypoint (architecture.md §6).
 *
 * No HTTP surface: everything it does arrives through the queue. Health is a
 * heartbeat file its own loop refreshes, because a container that is running
 * while its consumers have quietly died is otherwise indistinguishable from a
 * healthy one — and that is the failure that leaves a queue filling forever.
 */

const HEARTBEAT = '/tmp/chorus-worker-alive'

async function main(): Promise<void> {
  const dbConfig = configFromEnv()
  const queue = createQueue(redisConfigFromEnv())

  const indexer = await createIndexer(dbConfig, {
    // Wired to the model router in Phase 1. Until an embedding provider is
    // configured this fails loudly rather than embedding zeroes, because a
    // corpus of identical vectors is worse than an empty one: it returns
    // confident nonsense instead of nothing.
    embed: async () => {
      throw new Error('no embedding provider is configured (CHORUS_MODEL_TIERS)')
    },
    embeddingModel: 'unconfigured',
  })

  const worker = await createWorker({
    queue,
    dbConfig,
    indexer,
    access: {
      cloneUrlFor: async () => {
        // Minting a scoped token is the git connector's job (INT-2 AC2); wiring
        // it to the worker is the next slice. Failing here is deliberate: a
        // silent fallback to an unauthenticated clone would work for public
        // repositories and fail confusingly for every private one.
        throw new Error('repository access is not yet wired to the git connector')
      },
    },
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
