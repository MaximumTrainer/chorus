/**
 * One error hierarchy for the whole platform (architecture.md §28).
 *
 * Every error carries a stable `type` that maps to an RFC 9457 problem-details
 * URI at the HTTP boundary, so an API consumer can branch on the kind of
 * failure without parsing prose. Never throw strings; never swallow.
 */
export abstract class AppError extends Error {
  /** Stable, machine-readable discriminator. Never change one in place. */
  abstract readonly type: string
  /** HTTP status this maps to when it reaches the API boundary. */
  abstract readonly status: number
  /**
   * Whether retrying the identical request could plausibly succeed. Queue
   * consumers branch on this rather than on error text (NFR-6).
   */
  readonly retryable: boolean = false
  /** Structured context. Must never contain secrets — the logger redacts, but this should not need it. */
  readonly details: Readonly<Record<string, unknown>>

  constructor(message: string, details: Record<string, unknown> = {}, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
    this.details = Object.freeze({ ...details })
  }

  toProblemDetails(): {
    type: string
    title: string
    status: number
    detail: string
    [key: string]: unknown
  } {
    return {
      type: `https://chorus.dev/problems/${this.type}`,
      title: this.name,
      status: this.status,
      detail: this.message,
      ...this.details,
    }
  }
}

/** The caller asked for something malformed. */
export class ValidationError extends AppError {
  readonly type = 'validation'
  readonly status = 400
}

/** The caller is not authenticated. */
export class UnauthenticatedError extends AppError {
  readonly type = 'unauthenticated'
  readonly status = 401
}

/**
 * The caller is authenticated but not permitted. Note that for a resource in
 * another workspace we return NotFound instead — existence is information
 * (WS-2 AC4).
 */
export class ForbiddenError extends AppError {
  readonly type = 'forbidden'
  readonly status = 403
}

export class NotFoundError extends AppError {
  readonly type = 'not_found'
  readonly status = 404
}

/** Two writers changed the same thing; the caller must reconcile. */
export class ConflictError extends AppError {
  readonly type = 'conflict'
  readonly status = 409
}

/** A state machine refused an illegal transition (architecture.md §4.3). */
export class TransitionError extends AppError {
  readonly type = 'illegal_transition'
  readonly status = 409
}

/** A dependency failed in a way that may succeed on retry. */
export class UpstreamError extends AppError {
  readonly type = 'upstream'
  readonly status = 502
  override readonly retryable = true
}

/** A configured limit was reached: spend, quota, rate. */
export class LimitExceededError extends AppError {
  readonly type: string = 'limit_exceeded'
  readonly status = 429
  override readonly retryable = true
}

/**
 * A source asked us to slow down (INT-1 AC4).
 *
 * Distinct from its parent because the two demand opposite responses: a spend
 * quota means stop and tell someone, a rate limit means wait exactly this long
 * and carry on. A runner that cannot tell them apart either abandons a sync it
 * should have resumed, or hammers a source it should have backed off from.
 *
 * `retryAfterMs` comes from the source's own headers where it offers them, so
 * the wait is what the source asked for rather than a guess.
 */
export class RateLimitedError extends LimitExceededError {
  override readonly type: string = 'rate_limited'

  constructor(
    message: string,
    details: Record<string, unknown> & { retryAfterMs: number },
    options?: { cause?: unknown },
  ) {
    super(message, details, options)
  }

  get retryAfterMs(): number {
    return this.details.retryAfterMs as number
  }
}

/**
 * The deployment is misconfigured. Never retryable: a human must act.
 *
 * `type` is widened to `string` rather than left as a literal because this
 * error is designed to be subclassed by packages that want a more specific
 * discriminator while remaining catchable as a configuration problem — for
 * example the model router's capability failure.
 */
export class ConfigurationError extends AppError {
  readonly type: string = 'configuration'
  readonly status = 500
}
