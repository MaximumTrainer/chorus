export type {
  AuthSpec,
  Capabilities,
  Connector,
  ConnectorContext,
  ExternalRef,
  HealthStatus,
  PullResult,
  SinkAction,
  SinkSpec,
  WebhookRequest,
  WebhookSpec,
} from './contract.js'
export { runSinkAction, runSinkBatch } from './sink-runner.js'
export type { SinkBatchItem, SinkItemOutcome } from './sink-runner.js'
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
export { createLinearConnector, linearWebhooks } from './linear/index.js'
export type { LinearOptions } from './linear/index.js'
export { adfToMarkdown, markdownToAdf } from './jira/adf.js'
export type { AdfNode, AdfMark } from './jira/adf.js'
export { createJiraConnector, jiraWebhooks } from './jira/index.js'
export type {
  JiraConnector,
  JiraOptions,
  JiraCreateIssueInput,
  JiraUpdateIssueInput,
  JiraTransitionInput,
  JiraCommentInput,
} from './jira/index.js'
export { detectHierarchyScheme, hierarchyFields } from './jira/hierarchy.js'
export type { HierarchyScheme, HierarchyConfig } from './jira/hierarchy.js'
export { createConfluenceConnector } from './confluence/index.js'
export type { ConfluenceOptions } from './confluence/index.js'
export { confluenceToMarkdown, markdownToConfluence } from './confluence/body.js'
export { validateStatusMap, requireMapping, requireTransition } from './jira/status-map.js'
export type { StatusMap, StatusMapProblem, JiraTransition } from './jira/status-map.js'
