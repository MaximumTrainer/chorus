-- 0006 — checkpoint policies (WS-3 AC5, architecture.md §11.5).
--
-- A checkpoint policy decides whether an autonomous step stops and asks a
-- human. Resolution order, most specific first:
--
--   1. team + workflow + kind
--   2. team + kind
--   3. workflow + kind      -- the workflow default, applying to every team
--   4. platform default     -- `ask`, held in code and deliberately not a row
--
-- team_id NULL means "not team-scoped"; workflow_name NULL means "not
-- workflow-scoped". Both NULL at once would be a single row that opened every
-- gate in the workspace, which is precisely the thing that must not be
-- settable in passing, so it is refused by a check constraint rather than left
-- to the resolver to ignore. Workspace-wide settings arrive with WS-7.

CREATE TABLE policies (
  id                    text PRIMARY KEY,
  workspace_id          text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id               text REFERENCES teams(id) ON DELETE CASCADE,
  workflow_name         text,
  checkpoint_kind       text NOT NULL CHECK (checkpoint_kind IN (
                          'before_create_artefacts',
                          'before_external_write',
                          'before_coding_job',
                          'before_spend_over'
                        )),
  mode                  text NOT NULL CHECK (mode IN ('auto', 'ask', 'never')),
  spend_threshold_cents integer CHECK (spend_threshold_cents IS NULL OR spend_threshold_cents >= 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,

  CONSTRAINT policies_scope_declared CHECK (team_id IS NOT NULL OR workflow_name IS NOT NULL)
);

-- One row per tier, so setting a policy is an upsert rather than an append that
-- leaves two contradictory rows and lets insertion order decide the gate.
-- COALESCE over the nullable columns because NULLs never compare equal, and a
-- plain unique index would therefore permit unlimited duplicate workflow
-- defaults.
CREATE UNIQUE INDEX policies_scope_key ON policies (
  workspace_id,
  coalesce(team_id, ''),
  coalesce(workflow_name, ''),
  checkpoint_kind
) WHERE deleted_at IS NULL;

CREATE INDEX policies_by_team ON policies (workspace_id, team_id);

-- NFR-3: a new tenant table gets its policy in the same migration.
ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies FORCE ROW LEVEL SECURITY;

CREATE POLICY policies_tenant ON policies
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
