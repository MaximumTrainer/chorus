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
