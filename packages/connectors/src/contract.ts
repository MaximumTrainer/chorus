import type { ConnectorKind, EntityCandidate, Signal } from '@chorus/core'

/**
 * The connector interface (architecture.md §17, INT-1).
 *
 * Every connector inherits this framework's correctness, which is why INT-1 is
 * Phase 0 work: getting credential encryption, cursor durability, webhook
 * deduplication and rate limiting right *once* is the difference between a
 * dozen reliable connectors and a dozen subtly broken ones.
 *
 * The interface grows with the framework rather than being declared whole up
 * front. Members arrive when a contract-kit guarantee demands them, so what is
 * here is what is tested — an optional member nothing implements is a promise
 * to connector authors that nothing keeps.
 */

/** How a connector authenticates. The framework stores and refreshes; the connector describes. */
export type AuthSpec =
  | {
      readonly kind: 'oauth2'
      readonly authorizationUrl: string
      readonly tokenUrl: string
      readonly scopes: readonly string[]
    }
  /** A long-lived token pasted by an admin — a PAT, an API key. */
  | { readonly kind: 'token'; readonly label: string }
  /**
   * A GitHub App installation. Distinct from `oauth2` because the credential is
   * an installation token minted from the app's own key, scoped to what the
   * installation was granted — not a user's token with the user's reach.
   */
  | { readonly kind: 'github_app'; readonly appId: string; readonly scopes: readonly string[] }
  /** No credential at all. The reference connector, and anything reading public data. */
  | { readonly kind: 'none' }

export interface Capabilities {
  /** Produces signals, by pull and/or webhook. */
  readonly source?: boolean
  /** Accepts writes — creating an issue, posting a message. */
  readonly sink?: boolean
  /** Exposes git repositories for indexing. */
  readonly repos?: boolean
}

/**
 * Health (INT-1 AC5).
 *
 * `problem` and `remedy` are separate fields rather than one message because
 * they have different audiences: the problem is what happened, the remedy is
 * what the reader should do about it, and a health check that reports only the
 * first leaves an admin staring at "401 Unauthorized" with no next step.
 */
export interface HealthStatus {
  readonly state: 'ok' | 'degraded' | 'failed'
  readonly checkedAt: Date
  /** What is wrong, in words. Absent when `state` is `ok`. */
  readonly problem?: string
  /** What the reader should do about it. Absent when `state` is `ok`. */
  readonly remedy?: string
}

/**
 * What a connector is given for a call.
 *
 * Deliberately narrow. A connector receives its *decrypted* credentials and
 * nothing else that could reach the database — the framework owns persistence,
 * so a connector cannot write a row that skips validation or tenancy.
 */
export interface ConnectorContext {
  readonly workspaceId: string
  readonly integrationId: string
  /** Decrypted for this call only. Never logged, never persisted by the connector. */
  readonly credentials: Readonly<Record<string, string>>
  readonly config: Readonly<Record<string, unknown>>
  /** Injected so tests are deterministic (CLAUDE.md §5). */
  readonly now: () => Date
  /**
   * The connector's only way out to the network.
   *
   * Injected rather than reached for, so a test can substitute a cassette
   * player and a connector's parsing and pagination become the thing under
   * test. A connector calling global `fetch` is one that cannot be tested
   * without an account.
   */
  readonly fetch: typeof fetch
  /**
   * Replaces this integration's stored credentials — a refreshed access token,
   * a rotated secret.
   *
   * The framework re-encrypts and audits. A connector cannot reach the database
   * any other way, so this is the whole of its write access, and it is confined
   * to its own integration's credentials.
   */
  saveCredentials(next: Readonly<Record<string, string>>): Promise<void>
}

export interface PullResult {
  readonly signals: readonly Signal[]
  /**
   * Where to resume. `null` means "caught up" — not "start again", which is why
   * it is distinct from an absent cursor on the first call.
   */
  readonly nextCursor: string | null
}

/**
 * A delivery as it arrived (INT-1 AC3).
 *
 * `body` is the **raw** bytes as a string, never a parsed object. Re-serialising
 * a parsed body changes its HMAC — key order and whitespace both count — which
 * is the classic way a receiver rejects genuine deliveries in production and
 * nowhere else.
 */
export interface WebhookRequest {
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/**
 * How a connector's source signs and identifies its deliveries.
 *
 * Declared by the connector because every source does this differently — a
 * different header, a different digest, a timestamp folded into the signed
 * string. The framework owns what is uniform: storing, deduplicating, replaying
 * and ordering the checks correctly.
 */
export interface WebhookSpec {
  /**
   * The source's delivery identifier, from a header or the body.
   *
   * `null` means the delivery cannot be deduplicated, and the framework refuses
   * it — at-least-once delivery with no way to collapse repeats is worse than a
   * refusal, because it is invisible.
   */
  deliveryId(request: WebhookRequest): string | null
  /** Constant-time comparison is the connector's responsibility here. */
  verify(request: WebhookRequest, secret: string): boolean
  /** Which credential holds the signing secret. */
  readonly secretKey: string
  /**
   * How strong the source's webhook authentication actually is.
   *
   * `signature` — an HMAC over the raw body, as GitHub and Slack send. Proves
   * both that the sender holds the secret *and* that the body is untampered.
   *
   * `shared_secret` — the secret itself in a header, as GitLab sends. Proves
   * only possession. **The body is not authenticated**, so anyone who learns
   * the secret — from a log, a proxy, a misdirected request — can send any
   * payload they like, and replaying a captured delivery is trivial.
   *
   * Declared rather than inferred because the difference is invisible in the
   * code: both are a `verify` that returns a boolean, and a framework that
   * assumed the stronger one would silently claim a guarantee half its
   * connectors cannot provide. The contract kit asserts what each kind can
   * actually promise, so the weaker one is a recorded fact rather than an
   * unexamined one.
   */
  readonly verification: 'signature' | 'shared_secret'
}

export interface Connector {
  readonly kind: ConnectorKind
  readonly auth: AuthSpec
  readonly capabilities: Capabilities
  /** Absent for a sink-only connector. */
  pull?(cursor: string | null, ctx: ConnectorContext): Promise<PullResult>
  /** Present together with `handleWebhook`, or neither. */
  readonly webhooks?: WebhookSpec
  handleWebhook?(request: WebhookRequest, ctx: ConnectorContext): Promise<readonly Signal[]>
  /**
   * The deterministic extraction pass (architecture.md §10.3).
   *
   * What the signal *plainly says* exists — a tracker issue is a ticket, its
   * author is a person — with nothing inferred. Absent for a connector whose
   * source defines no entities of its own. Resolution and persistence are
   * BRAIN-3's; this is only the reading.
   */
  mapExternal?(signal: Signal): readonly EntityCandidate[]
  health(ctx: ConnectorContext): Promise<HealthStatus>
}
