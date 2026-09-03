import { UpstreamError } from '@chorus/core'
import {
  createGitHubConnector,
  type CredentialStore,
  type ConnectorContext,
} from '@chorus/connectors'
import type { RepositoryAccess } from './consumers/index-repository.js'

/**
 * Where a clone URL and a token for it come from (INT-2 AC2).
 *
 * Delegated to the git connector rather than reimplemented. Minting a
 * repository-scoped, short-lived token is a security control with its own
 * security suite, and a worker that knew how to do it would be a second place
 * that has to get scoping right — which is one more than can be kept correct.
 *
 * The token is returned and never stored. A stored short-lived token is a
 * long-lived one with extra steps.
 */

export interface GitAccessDeps {
  readonly credentials: CredentialStore
  /** Mints the app JWT. Held by the deployment, never by a workspace. */
  readonly appJwt?: () => Promise<string>
  readonly now?: () => Date
}

export function createGitRepositoryAccess(deps: GitAccessDeps): RepositoryAccess {
  const now = deps.now ?? (() => new Date())

  return {
    async cloneUrlFor({ workspaceId, provider, fullName }) {
      if (provider !== 'github') {
        // GitLab project tokens are the next slice. Failing by name beats a
        // silent unauthenticated clone, which works for public repositories and
        // fails confusingly for every private one.
        throw new UpstreamError(`Cloning a ${provider} repository is not wired yet`, { provider })
      }

      // The workspace's github integration. Named by kind rather than passed
      // in, because a repository row already records which integration it was
      // linked through and re-deriving it here would let the two disagree.
      const integration = await deps.credentials.findByKind(workspaceId, 'github')
      if (!integration) {
        throw new UpstreamError('This workspace has no connected GitHub integration', {
          workspaceId,
        })
      }

      const secrets = await deps.credentials.credentialsFor(workspaceId, integration.id)
      const context: ConnectorContext = {
        workspaceId,
        integrationId: integration.id,
        credentials: secrets,
        config: integration.config,
        now,
        fetch,
        saveCredentials: (next) =>
          deps.credentials.updateCredentials(workspaceId, integration.id, next),
      }

      const minted = await createGitHubConnector({
        ...(deps.appJwt ? { appJwt: deps.appJwt } : {}),
      }).mintRepositoryToken(fullName, context)

      return {
        remote: `https://github.com/${fullName}.git`,
        token: minted.token,
      }
    },
  }
}
