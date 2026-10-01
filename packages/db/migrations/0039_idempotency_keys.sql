-- 0039 — Idempotency-Key on the API (MCP-3 AC4, architecture.md §19).
--
-- A caller that sends a create and loses the reply cannot tell whether it went
-- through. Sending it again with the same key returns the response the first
-- one produced instead of making a second artefact. MCP's create tools pass
-- their `idempotencyKey` here, so an agent and a script get one guarantee.
--
-- A key belongs to the user who sent it, inside one workspace: two people
-- choosing the same string must not be answered with each other's work. Only a
-- successful response is kept. A refused request was never done, so a caller
-- who corrects it and retries with the same key should have it done now.
--
-- `response_status` is NULL while the first request is still running, which is
-- how a concurrent duplicate is told apart from a finished one.

CREATE TABLE idempotency_keys (
  id               text PRIMARY KEY,
  workspace_id     text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id          text NOT NULL,
  key              text NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  -- What the key was first used for. The same key on a different request is a
  -- caller's bug, and answering it with the first request's artefact would
  -- hide that bug behind a plausible-looking wrong answer.
  request_hash     text NOT NULL,
  response_status  integer,
  response_body    text,
  response_type    text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idempotency_keys_owner_key
  ON idempotency_keys (workspace_id, user_id, key);

-- NFR-3: a new tenant table gets its policy in the same migration.
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY idempotency_keys_tenant ON idempotency_keys
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
