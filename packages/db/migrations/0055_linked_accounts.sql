-- 0055 — a user's proven account at an external source (NFR-4 AC1, AND1).
--
-- Restricted content from a source reaches a Chorus user only through an
-- account at that source they have proved they own — an explicit link, never an
-- email match (decided 2026-11-13). A membership sync grants the source scopes
-- of the linked account to the Chorus user; unlinking revokes them.
--
-- Only the account id is kept. The OAuth tokens used to learn it are discarded:
-- the link is identity, not delegated access.
CREATE TABLE linked_accounts (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     text NOT NULL,
  account_id   text NOT NULL,
  linked_at    timestamptz NOT NULL DEFAULT now()
);

-- One account per provider per person; relinking replaces it.
CREATE UNIQUE INDEX linked_accounts_by_user ON linked_accounts (workspace_id, user_id, provider);
-- And one person per account: two people cannot both claim the same Atlassian
-- account in a workspace and both inherit its access.
CREATE UNIQUE INDEX linked_accounts_by_account ON linked_accounts (workspace_id, provider, account_id);

ALTER TABLE linked_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE linked_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY linked_accounts_tenant ON linked_accounts
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- A link in progress: started by one person, completed only by that person,
-- once, within minutes. The state is stored hashed, so a database read cannot
-- complete someone's link; the PKCE verifier lives only here, never in a URL.
CREATE TABLE account_link_requests (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  state_hash    text NOT NULL,
  code_verifier text NOT NULL,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX account_link_requests_state ON account_link_requests (workspace_id, state_hash);

ALTER TABLE account_link_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_link_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY account_link_requests_tenant ON account_link_requests
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
