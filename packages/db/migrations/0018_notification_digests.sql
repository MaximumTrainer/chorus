-- 0018 — digest mode (SLACK-6 AC5, architecture.md §11.8).
--
-- Per person, and off unless asked for. Batching somebody's mail without them
-- choosing it changes when they hear about things, which is not a default
-- anyone should acquire by upgrade.
--
-- Absence means off, so there is nothing to backfill and no row to go missing.

CREATE TABLE notification_digest_settings (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled      boolean NOT NULL DEFAULT false,
  -- How often the digest goes out. Stored per person because the useful
  -- cadence for someone watching one team is not the useful cadence for
  -- someone watching twelve.
  cadence_minutes integer NOT NULL DEFAULT 60
                    CHECK (cadence_minutes >= 5 AND cadence_minutes <= 1440),
  -- When one last went out, so a schedule that fires early or twice does not
  -- produce two digests an hour apart.
  last_sent_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One setting per person per workspace: this is an upsert, not an append.
CREATE UNIQUE INDEX notification_digest_settings_key
  ON notification_digest_settings (workspace_id, user_id);

-- NFR-3: a new tenant table gets its policy in the same migration.
ALTER TABLE notification_digest_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_digest_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_digest_settings_tenant ON notification_digest_settings
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
