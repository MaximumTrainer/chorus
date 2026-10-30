-- 0043 — the mapping between a Chorus task and its external tracker issue (TASK-4).
--
-- Chorus does not replace the tracker (architecture.md §1), so a pushed task is
-- two objects that must be kept in step: the Chorus task and the issue it
-- created. This row is the identity link between them — external id, the key a
-- person sees, and the url — and the state of their relationship.
--
-- `sync_state` is the point of the requirement. `conflict` is reached when both
-- sides changed since the last sync, and it exists so that neither side is
-- silently overwritten (AC3): an honest integration says "these disagree, you
-- decide" rather than quietly destroying an edit. `last_synced_hash` is how that
-- is detected — a content hash of the task as it stood at the last successful
-- sync, compared against both sides. A timestamp would produce false conflicts
-- under clock skew and miss them under fast edits.

CREATE TABLE task_tracker_links (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id        text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- Which integration the issue lives in, so the link records where it is and
  -- a push re-derives nothing. Cascades with the integration: an issue whose
  -- integration was disconnected has no link to mirror through.
  integration_id text NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  -- The external object's identity, as the sink returned it (INT-4 ExternalRef).
  external_id    text NOT NULL,
  external_key   text,
  external_url   text,
  sync_state     text NOT NULL DEFAULT 'synced'
                   CHECK (sync_state IN ('synced', 'pending', 'conflict')),
  -- The task's content hash at the last successful sync. Null until the first
  -- sync completes; the basis for conflict detection (AC3).
  last_synced_hash text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One link per task per integration. This is what makes a push idempotent at
-- the database rather than by check-then-insert: a second push of the same task
-- updates the issue it already has rather than opening a second (AC4), and a
-- race between a double-click and a replay cannot both insert.
CREATE UNIQUE INDEX task_tracker_links_one ON task_tracker_links (task_id, integration_id);
-- Inbound mirroring looks a link up by the external id a webhook carries (AC2).
CREATE INDEX task_tracker_links_by_external
  ON task_tracker_links (workspace_id, integration_id, external_id);

-- NFR-3: a new tenant table gets its policy in the same migration.
ALTER TABLE task_tracker_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_tracker_links FORCE ROW LEVEL SECURITY;
CREATE POLICY task_tracker_links_tenant ON task_tracker_links
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
