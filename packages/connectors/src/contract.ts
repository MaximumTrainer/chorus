import type { ConnectorKind, Signal } from '@chorus/core'

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
}

export interface PullResult {
  readonly signals: readonly Signal[]
  /**
   * Where to resume. `null` means "caught up" — not "start again", which is why
   * it is distinct from an absent cursor on the first call.
   */
  readonly nextCursor: string | null
}

export interface Connector {
  readonly kind: ConnectorKind
  readonly auth: AuthSpec
  readonly capabilities: Capabilities
  /** Absent for a sink-only connector. */
  pull?(cursor: string | null, ctx: ConnectorContext): Promise<PullResult>
  health(ctx: ConnectorContext): Promise<HealthStatus>
}
