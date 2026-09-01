import { Hono } from 'hono'
import { AppError, NotFoundError, ForbiddenError, ValidationError, ulid } from '@chorus/core'
import { withTenant, configFromEnv, type DbConfig } from '@chorus/db'
import { route, type RouteDefinition, type AppEnv, type ReadinessResult } from './routes.js'
import { createAuth, type Mailer, type OidcConfig } from './auth.js'
import { createTokenLedger } from './single-use-tokens.js'

/**
 * The API process (architecture.md §6).
 *
 * Errors leave as RFC 9457 problem documents with a stable `type` URI per class,
 * so a consumer branches on the kind of failure rather than parsing prose
 * (architecture.md §18).
 */

export type { ReadinessResult }

export interface AppOptions {
  /**
   * Injected so readiness can be exercised in both directions. A readiness
   * check that can only be observed succeeding is not a readiness check.
   */
  checkReadiness?: () => Promise<ReadinessResult>
  /** Injected so a test can point the app at its own isolated database. */
  dbConfig?: DbConfig
  /** Mail transport. A recording fake in tests; SMTP in a deployment. */
  mailer?: Mailer
  baseUrl?: string
  /** Failed attempts tolerated per window before throttling (WS-1 AC5). */
  maxSignInAttempts?: number
  /** A generic OIDC provider, discovered from its issuer (WS-1 AC3). */
  oidc?: OidcConfig
}

/**
 * Default readiness: the database must be reachable *and* the schema must be
 * current. A process that is alive but cannot serve requests must report
 * not-ready, or a load balancer will keep sending it traffic.
 */
function defaultReadiness(dbConfig?: DbConfig): () => Promise<ReadinessResult> {
  return async () => {
  try {
    await withTenant(
      'readiness-probe',
      async (tx) => {
        await tx.query('SELECT 1')
      },
      dbConfig ? { config: dbConfig } : {},
    )
    return { ready: true }
  } catch (error) {
    return { ready: false, reason: error instanceof Error ? error.message : 'database unreachable' }
  }
  }
}

function problem(error: AppError, requestId: string): Response {
  return new Response(JSON.stringify({ ...error.toProblemDetails(), requestId }), {
    status: error.status,
    headers: { 'content-type': 'application/problem+json' },
  })
}

export const ROUTES: readonly RouteDefinition[] = [
  route({
    method: 'GET',
    path: '/healthz',
    summary: 'Liveness: is this process running?',
    auth: {
      kind: 'public',
      reason: 'Liveness is polled by the container runtime before any credential exists.',
    },
    handler: (c) => c.json({ status: 'ok' }),
  }),
  route({
    method: 'GET',
    path: '/readyz',
    summary: 'Readiness: can this process serve requests?',
    auth: {
      kind: 'public',
      reason: 'Readiness is polled by orchestrators and load balancers without credentials.',
    },
    handler: async (c) => {
      const result = await c.get('checkReadiness')()
      return result.ready
        ? c.json({ status: 'ready' })
        : c.json({ status: 'not_ready', reason: result.reason ?? 'unknown' }, 503)
    },
  }),
  // Fixtures that let the error contract be tested through the real pipeline
  // rather than by calling the mapper directly.
  route({
    method: 'GET',
    path: '/__test/forbidden',
    summary: 'Test fixture: a declared AppError.',
    auth: { kind: 'public', reason: 'Test fixture, mounted only outside production.' },
    handler: () => {
      throw new ForbiddenError('nope')
    },
  }),
  route({
    method: 'GET',
    path: '/__test/boom',
    summary: 'Test fixture: an unexpected error.',
    auth: { kind: 'public', reason: 'Test fixture, mounted only outside production.' },
    handler: () => {
      throw new Error('secret internal detail')
    },
  }),
]

export function createApp(options: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Every response carries a request id so a user's report maps to a log line.
  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? ulid()
    c.set('requestId', requestId)
    c.set('checkReadiness', options.checkReadiness ?? defaultReadiness(options.dbConfig))
    await next()
    c.header('x-request-id', requestId)
  })

  // WS-1: authentication is mounted under /auth/*, per architecture.md §18.
  // The library owns these routes; they are public by necessity because a
  // caller has no credential until they have used them.
  if (options.mailer) {
    const auth = createAuth({
      mailer: options.mailer,
      ...(options.dbConfig ? { dbConfig: options.dbConfig } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.maxSignInAttempts === undefined
        ? {}
        : { maxSignInAttempts: options.maxSignInAttempts }),
      ...(options.oidc ? { oidc: options.oidc } : {}),
    })
    // WS-1 AC2: the library's verification tokens are stateless and therefore
    // replayable. Consumption is recorded here and a replay refused, before the
    // request reaches the library.
    const ledger = createTokenLedger(options.dbConfig ?? configFromEnv())

    app.on(['GET', 'POST'], '/auth/*', async (c) => {
      if (c.req.path.startsWith('/auth/verify-email')) {
        const token = new URL(c.req.url).searchParams.get('token')
        if (token && !(await ledger.consume(token, 'verify-email'))) {
          throw new ValidationError('This verification link has already been used.', {
            reason: 'token_already_used',
          })
        }
      }
      return auth.handler(c.req.raw)
    })
  }

  const isProduction = process.env.NODE_ENV === 'production'

  for (const definition of ROUTES) {
    if (definition.path.startsWith('/__test/') && isProduction) continue
    app.on(definition.method, definition.path, definition.handler)
  }

  app.notFound((c) =>
    problem(new NotFoundError(`No route for ${c.req.method} ${c.req.path}`), c.get('requestId') ?? ''),
  )

  app.onError((error, c) => {
    const requestId = c.get('requestId') ?? ''

    if (error instanceof AppError) {
      return problem(error, requestId)
    }

    // An unexpected error's message may contain anything at all, so it is
    // logged server-side and never returned. The request id is the bridge.
    console.error(JSON.stringify({ level: 'error', requestId, message: String(error), stack: (error as Error).stack }))
    return new Response(
      JSON.stringify({
        type: 'https://chorus.dev/problems/internal',
        title: 'InternalError',
        status: 500,
        detail: 'An unexpected error occurred.',
        requestId,
      }),
      { status: 500, headers: { 'content-type': 'application/problem+json' } },
    )
  })

  return app
}
