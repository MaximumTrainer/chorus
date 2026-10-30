import { UpstreamError, type SinkDispatch, type SinkDispatcher, type ExternalRef, type ToolContext } from '@chorus/core'
import {
  runSinkAction,
  type Connector,
  type ConnectorContext,
  type CredentialStore,
} from '@chorus/connectors'

/**
 * The worker's connector sink dispatcher (INT-4).
 *
 * The concrete half of the sink seam: a sink tool in the agent runtime states
 * *what* to write, and this resolves the workspace's connected tracker,
 * decrypts its credentials, and performs the write through the connector's own
 * sink action — idempotently, via `runSinkAction`, so a retry resolves to the
 * one object rather than making a second.
 *
 * It lives here, not in the runtime, because only an app may depend on both the
 * agent runtime and `@chorus/connectors`; the seam between them is the
 * `SinkDispatcher` contract in `core`, exactly as `RepositoryAccess` bridges to
 * the git connector in `access.ts`.
 */

export interface SinkDispatchDeps {
  readonly credentials: CredentialStore
  /**
   * The connectors that can sink, by kind, in the order a kind-agnostic write
   * resolves them. A tool naming no connector writes to the first of these the
   * workspace has connected — the tracker a team pushes to.
   */
  readonly connectors: ReadonlyArray<{ readonly kind: string; readonly create: () => Connector }>
  readonly now?: () => Date
  readonly fetch?: typeof fetch
}

export function createConnectorSinkDispatcher(deps: SinkDispatchDeps): SinkDispatcher {
  const now = deps.now ?? (() => new Date())
  const http = deps.fetch ?? fetch

  return {
    async dispatch(request: SinkDispatch, ctx: ToolContext): Promise<ExternalRef> {
      // The connector the write names, or the first connected one that can sink
      // — the workspace's tracker. Resolved from connected integrations rather
      // than assumed, so a workspace with no tracker fails by name rather than
      // writing nowhere.
      const candidates = request.connector
        ? deps.connectors.filter((c) => c.kind === request.connector)
        : deps.connectors

      for (const candidate of candidates) {
        const integration = await deps.credentials.findByKind(
          ctx.workspaceId,
          candidate.kind as Parameters<CredentialStore['findByKind']>[1],
        )
        if (!integration) continue

        const connector = candidate.create()
        const action = connector.sink?.actions[request.action]
        if (!action) {
          throw new UpstreamError(
            `The ${candidate.kind} connector has no "${request.action}" sink action`,
            { connector: candidate.kind, action: request.action },
          )
        }

        const secrets = await deps.credentials.credentialsFor(ctx.workspaceId, integration.id)
        const connectorCtx: ConnectorContext = {
          workspaceId: ctx.workspaceId,
          integrationId: integration.id,
          credentials: secrets,
          config: integration.config,
          now,
          fetch: http,
          saveCredentials: (next) =>
            deps.credentials.updateCredentials(ctx.workspaceId, integration.id, next),
        }

        return runSinkAction(action, request.input, request.idempotencyKey, connectorCtx)
      }

      throw new UpstreamError(
        request.connector
          ? `This workspace has no connected ${request.connector} integration`
          : 'This workspace has no connected tracker to write to',
        { workspaceId: ctx.workspaceId, ...(request.connector ? { connector: request.connector } : {}) },
      )
    },
  }
}
