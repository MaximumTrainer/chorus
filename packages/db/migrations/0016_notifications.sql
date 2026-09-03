-- 0016 — notifications, preferences and deliveries (SLACK-6, architecture.md §8.2).
--
-- The baseline surface. A self-hosted deployment may connect no chat surface at
-- all, and an `ask` checkpoint nobody is told about is not a delayed decision —
-- it is a run stopped forever with nobody aware. So in-app and email exist
-- independently of every integration.

CREATE TABLE notifications (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Addressed to a person, not to a workspace or a team. An inbox everyone
  -- shares is one nobody reads.
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  -- Urgent items bypass digest batching (AC5). Recorded per notification rather
  -- than derived from the kind, so one kind can be urgent in one context.
  priority     text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent', 'normal', 'low')),
  subject      text NOT NULL,
  body         text NOT NULL DEFAULT '',
  -- What to act on. A notification that announces something happened without
  -- saying where to go is a distraction rather than a prompt.
  target_type  text NOT NULL,
  target_id    text,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The two queries an inbox actually makes: "my unread count" and "my recent
-- notifications". The first is partial because a read notification never
-- contributes to it, and the badge is read on every page.
CREATE INDEX notifications_recent ON notifications (workspace_id, user_id, created_at DESC);
CREATE INDEX notifications_unread ON notifications (workspace_id, user_id)
  WHERE read_at IS NULL;

CREATE TABLE notification_preferences (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('in_app', 'email')),
  enabled      boolean NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per person per kind per channel, so setting a preference is an
-- upsert. An append would leave two contradictory rows and let insertion order
-- decide whether someone is told.
CREATE UNIQUE INDEX notification_preferences_key
  ON notification_preferences (workspace_id, user_id, kind, channel);

-- Absence means the default, which is held in code: a table pre-populated with
-- every kind for every user would have to be backfilled on each new kind, and
-- the row missing is exactly when someone stops being told.

CREATE TABLE notification_deliveries (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  notification_id text NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('in_app', 'email')),
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'failed', 'suppressed')),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- A delivery that claims to have been sent without an attempt behind it would
  -- make AC6's "failures are visible to admins" unanswerable.
  CONSTRAINT notification_deliveries_sent_was_attempted CHECK (
    status <> 'sent' OR (attempts > 0 AND delivered_at IS NOT NULL)
  )
);

-- One attempt record per notification per channel. Retries update the row
-- rather than appending, so "has this been delivered" stays a single answer.
CREATE UNIQUE INDEX notification_deliveries_key
  ON notification_deliveries (notification_id, channel);

-- AC6: what an admin needs to see, and what a retry job needs to find.
CREATE INDEX notification_deliveries_failed ON notification_deliveries (workspace_id, status)
  WHERE status IN ('pending', 'failed');

-- NFR-3: every new tenant table gets its policy in the same migration.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'notification_preferences',
                           'notification_deliveries'] LOOP
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
