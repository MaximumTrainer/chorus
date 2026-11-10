-- 0048 — a credential record shared across Atlassian products (INT-8/INT-9 AC1).
--
-- Connecting Jira and then Confluence is one Atlassian OAuth grant with
-- per-product scopes, not two sign-ins. A product added onto an existing grant
-- carries no credentials of its own: its row points at the integration that
-- holds them through `shared_credentials_id`, so a token refresh on the grant
-- is seen by every product on it and there is only ever one secret to rotate.
--
-- A column on an existing tenant table, not a new table: the row is already
-- scoped by the integrations RLS policy, and the reference stays within one
-- workspace because both rows do.
ALTER TABLE integrations
  ADD COLUMN shared_credentials_id text REFERENCES integrations(id) ON DELETE RESTRICT;

-- ON DELETE RESTRICT, not CASCADE: the grant owner cannot be removed while a
-- product still depends on its credentials, which would otherwise leave that
-- product unable to decrypt anything.
CREATE INDEX integrations_shared_credentials
  ON integrations (shared_credentials_id) WHERE shared_credentials_id IS NOT NULL;
