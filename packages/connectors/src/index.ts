export type {
  AuthSpec,
  Capabilities,
  Connector,
  ConnectorContext,
  HealthStatus,
  PullResult,
  WebhookRequest,
  WebhookSpec,
} from './contract.js'
export { createReferenceConnector } from './reference/index.js'
export type {
  ReferenceConnector,
  ReferenceItem,
  ReferenceScript,
} from './reference/index.js'
export { createCredentialStore } from './credentials.js'
export type { CredentialStore, IntegrationRecord, RotationResult } from './credentials.js'
export { createSyncRunner } from './sync.js'
export type { SyncRunner, SyncOutcome, SyncOptions, SyncState, SyncRunnerDeps } from './sync.js'
export { createWebhookReceiver } from './webhooks.js'
export type {
  WebhookReceiver,
  WebhookReceiverDeps,
  DeliveryOutcome,
  DeliveryState,
} from './webhooks.js'
export { createGitHubConnector } from './github/index.js'
export type { GitHubConnector, GitHubOptions, ScopedRepositoryToken } from './github/index.js'
export { createGitLabConnector, gitlabWebhooks } from './gitlab/index.js'
export type { GitLabOptions } from './gitlab/index.js'
