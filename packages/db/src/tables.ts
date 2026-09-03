/**
 * Tables carrying `workspace_id`, and therefore requiring a row-level security
 * policy and a case in the tenancy suite (NFR-3 AC1).
 *
 * The suite cross-checks this list against the live schema, so adding a tenant
 * table without adding it here fails the build rather than silently escaping
 * isolation testing.
 */
export const TENANT_TABLES = [
  'workspace_members',
  'teams',
  'team_members',
  'invitations',
  'api_tokens',
  'policies',
  'oauth_grants',
  'oauth_tokens',
  'workspace_data_keys',
  'integrations',
  'repositories',
  'repo_index_runs',
  'code_files',
  'code_symbols',
  'code_imports',
  'code_chunks',
  'route_map',
  'workflows',
  'runs',
  'run_steps',
  'run_events',
  'checkpoints',
  'signals',
  'webhook_deliveries',
  'audit_events',
] as const

export type TenantTable = (typeof TENANT_TABLES)[number]
