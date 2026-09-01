import { ulid, type AppError } from '@chorus/core'
import { createManagedPool, type DbConfig } from '@chorus/db'

/**
 * The authentication audit trail (WS-1 definition of done, NFR-5).
 *
 * Separate from `audit_events` because authentication precedes tenancy: a
 * person registers, verifies, and only then creates or joins a workspace.
 * Writing these into the tenant-scoped table would mean inventing a workspace
 * id or relaxing the RLS policy, and relaxing it would put a hole in the
 * boundary NFR-3 rests on.
 *
 * Keyed on the email address rather than a user id, because the most valuable
 * rows are those where no user exists — repeated failures against addresses
 * that were never registered are the reconnaissance phase of credential
 * stuffing, and are invisible if keyed on a user.
 */

export type AuthEventKind =
  | 'registration'
  | 'email_verified'
  | 'sign_in'
  | 'sign_in_failed'
  | 'sign_out'
  | 'password_reset_requested'
  | 'password_reset'
  | 'account_linked'
  | 'rate_limited'

export interface AuthEvent {
  readonly kind: AuthEventKind
  readonly subject: string
  readonly userId?: string
  readonly ipAddress?: string
  readonly userAgent?: string
  readonly detail?: Record<string, unknown>
}

export interface AuthEventLog {
  record(event: AuthEvent): Promise<void>
}

export function createAuthEventLog(config: DbConfig): AuthEventLog {
  const pool = createManagedPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.ownerUser,
    password: config.ownerPassword,
    max: 3,
    label: 'auth-events',
  })

  return {
    async record(event) {
      try {
        await pool.query(
          `INSERT INTO auth_events (id, kind, subject, user_id, ip_address, user_agent, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            ulid(),
            event.kind,
            event.subject,
            event.userId ?? null,
            event.ipAddress ?? null,
            event.userAgent ?? null,
            event.detail ? JSON.stringify(event.detail) : null,
          ],
        )
      } catch (error) {
        // Never let auditing break authentication: a person unable to sign in
        // because the log is full is a worse outcome than a missing line. The
        // failure is loud in the operator's logs instead.
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'failed to record auth event',
            kind: event.kind,
            error: String(error),
          }),
        )
      }
    },
  }
}

/** Paths whose outcome is worth a line in the trail, and what to call it. */
const PATH_EVENTS: ReadonlyArray<{
  readonly match: RegExp
  readonly onSuccess?: AuthEventKind
  readonly onFailure?: AuthEventKind
}> = [
  { match: /\/sign-up\/email$/, onSuccess: 'registration' },
  { match: /\/sign-in\/email$/, onSuccess: 'sign_in', onFailure: 'sign_in_failed' },
  { match: /\/sign-out$/, onSuccess: 'sign_out' },
  { match: /\/verify-email/, onSuccess: 'email_verified' },
  { match: /\/callback\//, onSuccess: 'account_linked' },
  { match: /\/forget-password$/, onSuccess: 'password_reset_requested' },
  { match: /\/reset-password$/, onSuccess: 'password_reset' },
]

/**
 * Which event, if any, a completed auth request should record.
 *
 * A 429 is recorded as `rate_limited` regardless of path: knowing that a
 * throttle fired, and against whom, is the point of having one.
 */
export function eventForRequest(
  path: string,
  status: number,
): AuthEventKind | undefined {
  if (status === 429) return 'rate_limited'

  const rule = PATH_EVENTS.find((candidate) => candidate.match.test(path))
  if (!rule) return undefined

  return status < 400 ? rule.onSuccess : rule.onFailure
}

/**
 * The email a verification token concerns.
 *
 * The token is a signed JWT; its payload is read *without* verifying, purely to
 * label the audit row. The library performs the real verification — this must
 * never be used to make an authorisation decision, only to say which address an
 * attempt concerned.
 */
function subjectFromToken(token: string): string | undefined {
  try {
    const payload = token.split('.')[1]
    if (!payload) return undefined
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    return typeof claims.email === 'string' ? claims.email : undefined
  } catch {
    return undefined
  }
}

/** Best-effort subject extraction. Never returns a credential. */
export async function subjectOf(request: Request): Promise<string | undefined> {
  const url = new URL(request.url)

  const fromQuery = url.searchParams.get('email')
  if (fromQuery) return fromQuery

  const token = url.searchParams.get('token')
  if (token) {
    const fromToken = subjectFromToken(token)
    if (fromToken) return fromToken
  }

  if (request.method === 'POST') {
    try {
      const body = (await request.clone().json()) as Record<string, unknown>
      if (typeof body.email === 'string') return body.email
    } catch {
      // Not JSON, or already consumed: the trail records what it can.
    }
  }
  return undefined
}

export function isAppError(error: unknown): error is AppError {
  return typeof error === 'object' && error !== null && 'type' in error && 'status' in error
}
