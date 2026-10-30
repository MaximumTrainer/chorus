import type { ZodType } from 'zod'
import type { Role, Scope } from './permissions.js'

/**
 * The tool contract (AGENT-5, architecture.md §11.4).
 *
 * In `core` rather than in the agent runtime because the MCP server implements
 * tools against the same interface, and WS-4 AC5 requires the permitted set over
 * MCP to be identical to the permitted set over HTTP. Two definitions of what a
 * tool is would make that something to re-verify forever instead of true by
 * construction.
 *
 * A tool is deliberately *typed at both ends*. A model produces input, and a
 * model will eventually produce input that is wrong — so the boundary validates
 * rather than trusting, and validates the output too, because a tool returning
 * a shape its schema forbids is a bug that otherwise surfaces three steps later
 * as something inexplicable.
 */

/**
 * What a tool does to the world, which decides how carefully it is gated.
 *
 * `none` — reads only. `internal` — changes Chorus's own data, which is
 * recoverable and audited. `external` — changes something outside Chorus: an
 * issue created, a message posted, a pull request opened. Only the third is
 * irreversible from here, and it is the one that must pass a checkpoint.
 */
export type SideEffect = 'none' | 'internal' | 'external'

/**
 * What a tool is given.
 *
 * Deliberately *not* the request context. A tool receives tenancy, the acting
 * identity and the run id, and nothing that would let it reach the database
 * directly or act as anyone but the person who started the run.
 */
export interface ToolContext {
  readonly workspaceId: string
  readonly teamId: string
  readonly runId: string
  /**
   * The person the run acts for, and the role they actually hold.
   *
   * AGENT-5 AC5: an agent never holds elevated privileges. A tool invoked in a
   * run started by a `member` is refused an operation requiring
   * `senior_member`, because otherwise "ask the agent to do it" becomes a
   * privilege-escalation path that looks like a feature.
   */
  readonly actor: { readonly userId: string; readonly role: Role }
  /** Injected so tests are deterministic (CLAUDE.md §5). */
  readonly now: () => Date
  /** A tool's only route to the network, and only where one is granted. */
  readonly fetch?: typeof fetch
  /**
   * A sink tool's only route to a connector write (INT-4).
   *
   * Declared here, in `core`, for the same reason the tool contract is: the
   * agent runtime holds a sink tool but cannot reach `@chorus/connectors`
   * (the dependency rule forbids it, as it does between `coding` and
   * `testing` — which is why the `Sandbox` contract lives here too). The tool
   * states *what* to write; the dispatcher the worker supplies resolves the
   * workspace's integration, decrypts its credentials, and performs the write
   * idempotently. A tool given no dispatcher cannot write, which is the right
   * failure for a deployment that wired none.
   */
  readonly sinkDispatcher?: SinkDispatcher
}

/** A reference to the external object a sink write created or found (INT-4). */
export interface ExternalRef {
  readonly externalId: string
  readonly url?: string
}

/** One external write, as a sink tool asks for it (INT-4). */
export interface SinkDispatch {
  /**
   * Which connector performs it — a tracker kind like `linear`. Omitted when
   * the tool is kind-agnostic and the dispatcher resolves the workspace's
   * connected tracker for the team.
   */
  readonly connector?: string
  /** The sink action, e.g. `create_issue`. */
  readonly action: string
  /** The action's input, already validated by the tool's own schema. */
  readonly input: unknown
  /**
   * The idempotency key the tool derived from its input, carried through so a
   * retry — including one after a lost response — resolves to the one object
   * the connector's search-before-create finds rather than making a second.
   */
  readonly idempotencyKey: string
}

/**
 * Performs a sink tool's external write (INT-4).
 *
 * The seam between a sink tool (in the agent runtime) and the connector that
 * actually writes (in `@chorus/connectors`, which the runtime may not import).
 * The worker implements it over the credential store and the connector
 * registry; a test implements it with a fake. Either way the tool stays the
 * same code.
 */
export interface SinkDispatcher {
  dispatch(request: SinkDispatch, ctx: ToolContext): Promise<ExternalRef>
}

export interface Tool<I, O> {
  readonly name: string
  /** Shown to a model choosing between tools, so it earns its wording. */
  readonly description: string
  readonly input: ZodType<I>
  readonly output: ZodType<O>
  readonly sideEffect: SideEffect
  /** The least role that may invoke it. Checked against the *actor's* role. */
  readonly requiredRole: Role
  readonly requiredScopes: readonly Scope[]
  /**
   * Derives a stable key from the input, so a retry cannot duplicate an
   * external effect (AC4).
   *
   * Required for `external` tools and meaningless for the others: an internal
   * write is already inside a transaction, and a read has nothing to duplicate.
   */
  idempotencyKey?(input: I): string
  execute(input: I, ctx: ToolContext): Promise<O>
}

/**
 * A registered tool with its types erased, which is how a registry holds them.
 *
 * Declared as its own interface rather than `Tool<never, never>`. The generic
 * form does not unify under `exactOptionalPropertyTypes` — an optional method
 * on the source is not assignable to one on the target — and every concrete
 * `Tool<I, O>` *is* assignable to this, because `execute` is contravariant in
 * its input and `never` is the bottom type.
 */
export interface AnyTool {
  readonly name: string
  readonly description: string
  readonly input: ZodType
  readonly output: ZodType
  readonly sideEffect: SideEffect
  readonly requiredRole: Role
  readonly requiredScopes: readonly Scope[]
  idempotencyKey?(input: never): string
  execute(input: never, ctx: ToolContext): Promise<unknown>
}
