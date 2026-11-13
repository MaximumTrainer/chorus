-- 0054 — which source permission scopes a user holds (NFR-4 AC1, AND1).
--
-- A signal's permission scope is captured at ingest (a Confluence group, a
-- Slack channel) and retrieval and the brain map refuse a restricted signal to
-- a caller holding none of its scopes. This is the other half: the scopes each
-- user *does* hold, recorded by a connector's membership sync, so content
-- restricted to a group is visible to the group and to nobody else.
--
-- Retrieval resolves a caller's scopes from here by user id, so every path —
-- chat, search, MCP, the brain map — inherits one answer and no caller can
-- forget to pass them. A sync replaces a user's memberships *from one source*,
-- so a scope dropped upstream is dropped here and the next retrieval no longer
-- sees what it gated (AND1); another source's scopes are left alone.
CREATE TABLE source_scope_memberships (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Removing a user removes what they held; nothing is left to be re-granted.
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The connector kind that asserted the membership, so a sync of one source
  -- replaces only that source's scopes.
  source       text NOT NULL,
  -- Matches a signal's `permissions.scopeIds` entry exactly, e.g.
  -- `confluence:group:finance`.
  scope_id     text NOT NULL,
  synced_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per scope a user holds; a re-sync is a no-op rather than a duplicate.
CREATE UNIQUE INDEX source_scope_memberships_unique
  ON source_scope_memberships (workspace_id, user_id, scope_id);
-- Retrieval's lookup: every scope one user holds.
CREATE INDEX source_scope_memberships_by_user
  ON source_scope_memberships (workspace_id, user_id);

ALTER TABLE source_scope_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_scope_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY source_scope_memberships_tenant ON source_scope_memberships
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
