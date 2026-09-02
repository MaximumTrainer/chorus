-- 0008 — integrations and envelope-encrypted credentials (INT-1 AC1).
--
-- Two tables, and the split between them is the whole design.
--
-- `workspace_data_keys` holds one data key per workspace, wrapped by a master
-- key from the environment. `integrations.encrypted_credentials` holds the
-- credential, encrypted under that data key. Rotating the master key therefore
-- rewraps one small row per workspace and never touches a credential at all.
-- The single-level alternative makes rotation a migration that decrypts every
-- secret in the system to disk on its way past, which is why systems built that
-- way never rotate.
--
-- Both are tenant tables. The wrapped key is not a secret on its own — it is
-- useless without the master key — but it is workspace data, and a table that
-- is "not quite sensitive enough for a policy" is how boundaries erode.

CREATE TABLE workspace_data_keys (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- `v1.<masterKeyId>.<iv>.<ciphertext>.<tag>`. The master key id is carried so
  -- a rotation is resumable: an interrupted one leaves rows that can still be
  -- told apart, rather than a set nobody can classify.
  wrapped_key   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One key per workspace. A second would silently split a workspace's
-- credentials into two sets, one of which nothing could later decrypt.
CREATE UNIQUE INDEX workspace_data_keys_unique ON workspace_data_keys (workspace_id);

CREATE TABLE integrations (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  status        text NOT NULL DEFAULT 'connected'
                  CHECK (status IN ('connected', 'degraded', 'failed', 'disconnected')),
  -- Ciphertext under the workspace's data key. Never a plaintext credential,
  -- and never read by anything but the credential store.
  encrypted_credentials text,
  -- Non-secret settings: which channel, which project, which board.
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Where the last sync got to. Persisted so a restart resumes rather than
  -- restarting (AC2).
  sync_cursor   text,
  -- Last observed health, so the UI can answer without waiting on the source.
  health        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

-- A workspace may connect the same kind twice — two GitHub organisations, two
-- Jira sites — so `kind` is deliberately not unique here.
CREATE INDEX integrations_by_kind ON integrations (workspace_id, kind) WHERE deleted_at IS NULL;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_data_keys', 'integrations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY %1$I_tenant ON %1$I
        USING (workspace_id = current_setting('app.workspace_id', true))
        WITH CHECK (workspace_id = current_setting('app.workspace_id', true))
    $f$, t);
  END LOOP;
END
$$;
