export type {
  AuthSpec,
  Capabilities,
  Connector,
  ConnectorContext,
  HealthStatus,
  PullResult,
} from './contract.js'
export { createReferenceConnector } from './reference/index.js'
export type {
  ReferenceConnector,
  ReferenceItem,
  ReferenceScript,
} from './reference/index.js'
export { createCredentialStore } from './credentials.js'
export type { CredentialStore, IntegrationRecord, RotationResult } from './credentials.js'
