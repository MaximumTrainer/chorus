-- 0005 — an invitation can be found by the person redeeming it (WS-2 AC2, AC3).
--
-- Accepting an invitation is a chicken-and-egg problem: the row must be read
-- before the reader is a member, so no tenant context exists yet to read it
-- under. The invitation token *is* the authorisation -- possessing it is the
-- whole proof -- so the rule is stated as exactly that:
--
--   a transaction may see one invitation, the one whose token it presents.
--
-- The redeeming transaction sets `app.invitation_token` to the hash it holds,
-- and the policy admits precisely that row. This is narrower than it looks: it
-- grants no listing, no enumeration, and nothing about any other invitation or
-- any other table. A caller who does not hold a token sees nothing, because
-- current_setting returns NULL and `= NULL` is never true.

DROP POLICY IF EXISTS invitations_tenant ON invitations;

CREATE POLICY invitations_tenant ON invitations
  USING (
    workspace_id = current_setting('app.workspace_id', true)
    OR token_hash = current_setting('app.invitation_token', true)
  )
  -- Creating and updating an invitation stays strictly tenant-scoped. Holding
  -- a token must never become the ability to mint or alter one.
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
