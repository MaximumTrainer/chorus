-- 0017 — checkpoint decision links (SLACK-6 AC2, architecture.md §11.5).
--
-- A link in an email is a bearer credential. It sits in a mailbox, in browser
-- history, in a forwarded thread and often in a corporate mail archive, so
-- every column here exists to narrow what a leaked one can do.
--
-- Bound to one checkpoint and one person: it settles that gate, attributed to
-- them, and opens nothing else. It is emphatically not a session — the
-- requirement's words are "never a general-purpose session link in an email".

CREATE TABLE checkpoint_decision_tokens (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  checkpoint_id text NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  -- Who the link was sent to. The decision is recorded against them, so an
  -- approval arriving by email is as attributable as one made in the app.
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Only the hash. The table is a place to check a token against, never a
  -- place to look one up, so storing the plaintext would add risk and no
  -- capability — a database dump must not hand over every open gate.
  token_hash    text NOT NULL,
  -- Bound to the gate's own deadline: a token outliving the checkpoint it
  -- belongs to is a credential for something that can no longer happen, and a
  -- shorter window would strand a recipient whose gate is still open.
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The lookup is by hash and must be unambiguous. Unique across the whole table
-- rather than per workspace, because the token is resolved *before* any
-- workspace is known — that is what an opaque credential means.
CREATE UNIQUE INDEX checkpoint_decision_tokens_hash ON checkpoint_decision_tokens (token_hash);

-- One live token per person per checkpoint. Re-notifying the same person about
-- the same gate must not scatter working credentials across their mailbox.
CREATE UNIQUE INDEX checkpoint_decision_tokens_recipient
  ON checkpoint_decision_tokens (checkpoint_id, user_id);

-- NFR-3: a new tenant table gets its policy in the same migration. Resolution
-- by hash necessarily runs on an owner connection, since there is no workspace
-- to set until the token has been resolved; that path returns only the tenancy
-- it found, and every read and write after it is tenant-scoped as usual.
ALTER TABLE checkpoint_decision_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoint_decision_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY checkpoint_decision_tokens_tenant ON checkpoint_decision_tokens
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
