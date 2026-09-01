-- 0004 — a user can always see their own membership rows (WS-2 AC1, AC4).
--
-- "Which workspaces do I belong to?" is inherently cross-tenant: it must be
-- answerable *before* a tenant context exists, since the answer is what
-- establishes one. The tempting shortcuts are both wrong:
--
--   * querying as the owner role to bypass RLS would breach ADR-0003's rule
--     that there is exactly one way to reach the database, and put the
--     bypass in application code where no policy can constrain it;
--   * copying membership into a second, unprotected table would give the
--     same data two sources of truth and one set of policies.
--
-- Instead the rule is stated in SQL, where it can be reasoned about: a
-- membership row is visible if it belongs to the current workspace OR if it is
-- your own. Crucially this exposes only the caller's *own* rows in other
-- workspaces -- never anyone else's, and never any other table.

DROP POLICY IF EXISTS workspace_members_tenant ON workspace_members;

CREATE POLICY workspace_members_tenant ON workspace_members
  USING (
    workspace_id = current_setting('app.workspace_id', true)
    OR user_id = current_setting('app.user_id', true)
  )
  -- Writes stay strictly tenant-scoped. Being able to see your own membership
  -- elsewhere must not become the ability to grant yourself one.
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
