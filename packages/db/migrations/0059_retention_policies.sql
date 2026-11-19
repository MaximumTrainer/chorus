-- 0059 — retention periods per data class (NFR-4 AC3, WS-7 AC4).
--
-- One row per class a workspace has chosen to purge. No row means the class is
-- kept: deleting by default is the one choice that cannot be undone, so the
-- default periods are an owner's decision (plan.md D-10) rather than ours.
--
-- The class list is checked here as well as in `@chorus/core`, so a period for
-- a class nothing purges cannot be stored by a path that skipped validation.
-- Numbered 0059 so it does not collide with 0058 on the open BRAIN-1 branch.

CREATE TABLE retention_policies (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  data_class   text NOT NULL CHECK (data_class IN ('prompts', 'run_traces')),
  days         integer NOT NULL CHECK (days BETWEEN 1 AND 3650),
  updated_by   text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, data_class)
);

-- The purge selects by age; without these it reads every event a workspace
-- has ever recorded to find the few that are due.
CREATE INDEX run_events_by_age ON run_events (workspace_id, at);

-- NFR-3: a new tenant table gets its policy in the same migration.
ALTER TABLE retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY retention_policies_tenant ON retention_policies
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
