import { createAtlassianIdentity } from '@chorus/connectors'
import { createRetriever } from '@chorus/brain'
import { configFromEnv } from '@chorus/db'
import { providersFromEnv, routerConfigFromEnv } from '@chorus/llm'
import { createApp } from './app.js'
import { createLogMailer } from './log-mailer.js'

/**
 * The API as a deployment builds it: from `CHORUS_*` variables and nothing
 * else (NFR-1).
 *
 * Separate from `main.ts` so the composition a running system uses is the one
 * the acceptance suite drives. Every other test assembles the app by hand, and
 * a composition nobody tests is how a deployment shipped with no way to sign in.
 */

export interface CompositionDeps {
  /** Where operator-facing lines go. Standard error in a deployment. */
  readonly log?: (line: string) => void
}

export function createAppFromEnvironment(env: NodeJS.ProcessEnv, deps: CompositionDeps = {}) {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const port = Number(env.CHORUS_PORT ?? 3000)

  // Linking a person's own Atlassian account (NFR-4) needs an Atlassian OAuth app.
  // Without one the routes still exist and answer that linking is not configured.
  const atlassianClientId = env.CHORUS_ATLASSIAN_CLIENT_ID
  const atlassianClientSecret = env.CHORUS_ATLASSIAN_CLIENT_SECRET

  const dbConfig = configFromEnv(env)

  // Models are configured or they are not (ADR-0015, as the worker reads it).
  // Configured, the tiers are validated now, at boot, and the embed tier's
  // first model is the one retrieval embeds queries with: it must be the model
  // the worker embedded the corpus with, or the two sets of vectors are
  // comparable to nothing. Not configured is a fresh install, which still
  // starts; search then says what is missing.
  const configured = Boolean(env.CHORUS_MODEL_TIERS?.trim())
  const models = configured ? providersFromEnv(env) : undefined
  const retriever = configured
    ? createRetriever(dbConfig, { models: models!, embeddingModel: routerConfigFromEnv(env).embed[0]!.ref })
    : undefined

  return createApp({
    dbConfig,
    ...(models ? { models } : {}),
    ...(retriever ? { retriever } : {}),
    // Without a transport `/auth/*` is not mounted, and a fresh install is one
    // nobody can sign in to. The log is the transport every deployment has.
    mailer: createLogMailer(log),
    baseUrl: env.CHORUS_BASE_URL ?? `http://localhost:${port}`,
    // Empty unless a deployment names them. Behind one reverse proxy the web app
    // shares this origin and needs none; on separate hosts it does, and guessing
    // would make every authenticated route callable by any page.
    webOrigins: (env.CHORUS_WEB_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
    identityProviders:
      atlassianClientId && atlassianClientSecret
        ? { atlassian: createAtlassianIdentity({ clientId: atlassianClientId, clientSecret: atlassianClientSecret }) }
        : {},
  })
}
