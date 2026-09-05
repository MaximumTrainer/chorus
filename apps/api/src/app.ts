import { Hono } from 'hono'
import { AppError, NotFoundError, ForbiddenError, ValidationError, ulid } from '@chorus/core'
import type { ModelProvider } from '@chorus/llm'
import { currentTraceId, withSpan } from '@chorus/telemetry'
import { withTenant, configFromEnv, type DbConfig } from '@chorus/db'
import {
  route,
  type RouteDefinition,
  type AppEnv,
  type AppContext,
  type ReadinessResult,
} from './routes.js'
import { createAuth, type Mailer, type OidcConfig } from './auth.js'
import { createWorkspaceService } from './workspaces.js'
import { workspaceRoutes } from './workspace-routes.js'
import { createTeamService } from './teams.js'
import { teamRoutes } from './team-routes.js'
import { createApiTokenService } from './api-tokens.js'
import { apiTokenRoutes } from './api-token-routes.js'
import { createOAuthService, OAuthError } from './oauth.js'
import { oauthRoutes } from './oauth-routes.js'
import { createRepositoryService } from './repositories.js'
import { repositoryRoutes } from './repository-routes.js'
import { runRoutes, type RunResumer } from './run-routes.js'
import { notificationRoutes } from './notification-routes.js'
import { decisionLinkRoutes } from './decision-link-routes.js'
import { createTaskService } from './tasks.js'
import { taskRoutes } from './task-routes.js'
import { createPointerService } from './pointers.js'
import { pointerRoutes } from './pointer-routes.js'
import { createDocumentService } from './documents.js'
import { documentRoutes } from './document-routes.js'
import { createSessionService } from './sessions.js'
import { sessionRoutes } from './session-routes.js'
import { createRetriever } from '@chorus/brain'
import { createNotifier } from '@chorus/notifications'
import { createDecisionLinks } from '@chorus/agent'
// WALKING SKELETON — delete in Phase 1. See src/walking-skeleton/README.md.
import { walkingSkeletonRoutes } from './walking-skeleton/ask.js'
import { authorise, type AuthorisationDeps } from './authorisation.js'
import { createTokenLedger } from './single-use-tokens.js'
import {
  createAuthEventLog,
  eventForRequest,
  resolveResetSubject,
  subjectOf,
} from './auth-events.js'

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
  /**
   * How a run is continued once a checkpoint is decided (AGENT-3).
   *
   * Injected because the API settles decisions and does not execute runs: in a
   * deployment this enqueues, and a route that ran the workflow inline would
   * tie a browser to however long the rest of it takes.
   */
  resumeRun?: RunResumer
  /**
   * The model provider. Injected so a test never reaches a real one
   * (CLAUDE.md §4).
   *
   * WALKING SKELETON: only the throwaway ask route uses this. Phase 1's agent
   * runtime takes its provider through the model router instead.
   */
  models?: ModelProvider
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

/**
 * Every route the API can serve, built once and used both to mount the app and
 * to enumerate it (WS-4 AC4).
 *
 * The guarantee that no route is silently unguarded rests entirely on being
 * able to enumerate them, so the check must see the *same* table that gets
 * mounted. A separate list maintained for the test would drift, and the first
 * route it missed would be exactly the one nobody declared.
 *
 * Building the table opens no connections — the services close over their
 * config — so this is safe to call from a test that has no database.
 */
export function routeTable(dbConfig?: DbConfig, models?: ModelProvider): readonly RouteDefinition[] {
  return buildRoutes(dbConfig ?? configFromEnv(), models).table
}

function buildRoutes(
  config: DbConfig,
  models?: ModelProvider,
  resumeRun?: RunResumer,
  mailer?: Mailer,
  baseUrl = 'http://localhost:3000',
): {
  table: readonly RouteDefinition[]
  deps: AuthorisationDeps
} {
  const workspaces = createWorkspaceService(config)
  const teams = createTeamService(config)
  const tokens = createApiTokenService(config)
  const oauth = createOAuthService(config)
  const repositories = createRepositoryService(config)
  return {
    table: [
      ...ROUTES,
      ...workspaceRoutes(workspaces),
      ...teamRoutes(teams),
      ...apiTokenRoutes(tokens),
      ...repositoryRoutes(repositories),
      ...runRoutes(config, resumeRun),
      ...taskRoutes(createTaskService(config)),
      ...documentRoutes(createDocumentService(config)),
      ...sessionRoutes(createSessionService(config)),
      // Pointers retrieve through the one retrieval function, so a pointer can
      // never surface code the person could not open (BRAIN-4 AC2).
      ...(models
        ? pointerRoutes(
            createPointerService(
              config,
              createRetriever(config, {
                models,
                embeddingModel: { provider: 'unconfigured', model: 'unconfigured' },
              }),
            ),
          )
        : []),
      ...notificationRoutes(createNotifier(config, { baseUrl, ...(mailer ? { mail: mailer } : {}) })),
      ...decisionLinkRoutes(config, createDecisionLinks(config), resumeRun),
      // WALKING SKELETON — delete in Phase 1. Mounted only when a provider is
      // supplied, so a deployment without one simply does not have it.
      ...(models ? walkingSkeletonRoutes({ dbConfig: config, models }) : []),
      // The issuer is read from the request context rather than baked in, so
      // the metadata document a client discovers names the host it actually
      // reached — a mismatch there is what makes discovery fail unattended.
      ...oauthRoutes(oauth, workspaces, (c) => c.get('baseUrl')),
    ],
    deps: { workspaces, teams, tokens, oauth, dbConfig: config },
  }
}

/**
 * A subject for events where the request carries no address — a verification
 * link, an OAuth callback. Recorded as unknown rather than omitted, so the row
 * still exists and the gap is visible.
 */
function subjectFromResponsePath(path: string): string {
  return `unknown:${path}`
}

/**
 * Resolves the session into `user`, or leaves it absent.
 *
 * Deliberately does not reject: routes declare their own requirement, and a
 * middleware that refused everything unauthenticated would make a public route
 * impossible to express (WS-4 AC4).
 */
function sessionResolver(auth: ReturnType<typeof createAuth>) {
  return async (c: AppContext, next: () => Promise<void>): Promise<void> => {
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers })
      if (session?.user?.id && session.user.email) {
        c.set('user', { id: session.user.id, email: session.user.email })
      }
    } catch {
      // An unreadable session is simply an absent one.
    }
    await next()
  }
}

export function createApp(options: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Every response carries a request id so a user's report maps to a log line,
  // and every request is a span so that line maps to a trace (NFR-5 AC2).
  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? ulid()
    c.set('requestId', requestId)
    c.set('checkReadiness', options.checkReadiness ?? defaultReadiness(options.dbConfig))
    c.set('baseUrl', options.baseUrl ?? 'http://localhost:3000')
    if (options.mailer) c.set('mailer', options.mailer)

    // Named by route pattern, not by URL: a span per concrete path produces one
    // trace name per workspace id, which makes latency by endpoint
    // unanswerable — the question traces are most often asked.
    await withSpan(
      `http.${c.req.method} ${c.req.routePath}`,
      {
        'http.request.method': c.req.method,
        'http.route': c.req.routePath,
        'chorus.request_id': requestId,
      },
      async () => {
        await next()
      },
    )

    c.header('x-request-id', requestId)
    // Emitted so a user's report reaches the trace, not only the log line.
    const traceId = currentTraceId()
    if (traceId) c.header('x-trace-id', traceId)
  })

  // WS-1: authentication is mounted under /auth/*, per architecture.md §18.
  // The library owns these routes; they are public by necessity because a
  // caller has no credential until they have used them.
  let authInstance: ReturnType<typeof createAuth> | undefined
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
    authInstance = auth
    // WS-1 AC2: the library's verification tokens are stateless and therefore
    // replayable. Consumption is recorded here and a replay refused, before the
    // request reaches the library.
    const dbConfig = options.dbConfig ?? configFromEnv()
    const ledger = createTokenLedger(dbConfig)
    const authEvents = createAuthEventLog(dbConfig)

    app.on(['GET', 'POST'], '/auth/*', async (c) => {
      // The subject is read before the handler runs: a POST body can only be
      // consumed once, and the handler needs it.
      let subject = await subjectOf(c.req.raw)

      // A reset submission carries only an opaque token, and the handler
      // consumes the row that maps it to a person. Resolve first, or the most
      // security-sensitive event in the system cannot be attributed.
      if (!subject && c.req.path.endsWith('/reset-password')) {
        try {
          const body = (await c.req.raw.clone().json()) as { token?: unknown }
          if (typeof body.token === 'string') {
            subject = await resolveResetSubject(dbConfig, body.token)
          }
        } catch {
          // Unparseable body: the row is still written, labelled unknown.
        }
      }

      // Sign-out carries a cookie, not an address, and the handler destroys the
      // session it would be resolved from -- so resolve it first, or the most
      // ordinary event in the trail is the one that cannot be attributed.
      if (!subject && c.req.path.endsWith('/sign-out')) {
        try {
          const session = await auth.api.getSession({ headers: c.req.raw.headers })
          subject = session?.user?.email
        } catch {
          // An unresolvable session still gets a row, labelled unknown.
        }
      }

      if (c.req.path.startsWith('/auth/verify-email')) {
        const token = new URL(c.req.url).searchParams.get('token')
        if (token && !(await ledger.consume(token, 'verify-email'))) {
          throw new ValidationError('This verification link has already been used.', {
            reason: 'token_already_used',
          })
        }
      }

      const response = await auth.handler(c.req.raw)

      const kind = eventForRequest(c.req.path, response.status)
      if (kind) {
        // Awaited, not fired-and-forgotten. An audit event that may or may not
        // have been written is not an audit trail, and the few milliseconds
        // matter less than the guarantee. record() swallows its own failures,
        // so this still cannot break authentication.
        await authEvents.record({
          kind,
          subject: subject ?? subjectFromResponsePath(c.req.path),
          ...(c.req.header('x-forwarded-for')
            ? { ipAddress: c.req.header('x-forwarded-for')! }
            : {}),
          ...(c.req.header('user-agent') ? { userAgent: c.req.header('user-agent')! } : {}),
          detail: { path: c.req.path, status: response.status },
        })
      }

      return response
    })
  }

  // Resolve the session once per request. Routes then declare the role they
  // need rather than each re-deriving identity (WS-4 AC4).
  if (options.mailer) {
    const auth = authInstance!
    app.use('/workspaces/*', sessionResolver(auth))
    app.use('/workspaces', sessionResolver(auth))
    app.use('/invitations/*', sessionResolver(auth))
    // The consent endpoints need the granter's identity (WS-5 AC3). The rest of
    // /oauth/* is unauthenticated by design, and resolving a session there is
    // harmless — those routes declare `public` and never read it.
    app.use('/oauth/*', sessionResolver(auth))
  }

  const isProduction = process.env.NODE_ENV === 'production'
  const built =
    options.dbConfig || options.mailer
      ? buildRoutes(
          options.dbConfig ?? configFromEnv(),
          options.models,
          options.resumeRun,
          options.mailer,
          options.baseUrl,
        )
      : undefined

  for (const definition of built?.table ?? ROUTES) {
    if (definition.path.startsWith('/__test/') && isProduction) continue

    // The declaration is what enforces (WS-4 AC4). Mounting the handler alone
    // is what made the declaration decorative, so authorisation is attached
    // here, from the same data the permission suite enumerates — a route
    // cannot be mounted without the check its declaration describes.
    if (built) {
      app.on(definition.method, definition.path, authorise(definition, built.deps), definition.handler)
    } else {
      app.on(definition.method, definition.path, definition.handler)
    }
  }

  app.notFound((c) =>
    problem(new NotFoundError(`No route for ${c.req.method} ${c.req.path}`), c.get('requestId') ?? ''),
  )

  app.onError((error, c) => {
    const requestId = c.get('requestId') ?? ''

    // OAuth has its own error contract (RFC 6749 §5.2): a client library
    // branches on `error`, and would find our problem+json unparseable.
    if (error instanceof OAuthError) {
      return new Response(
        JSON.stringify({ error: error.code, error_description: error.message }),
        {
          status: error.status,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        },
      )
    }

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
