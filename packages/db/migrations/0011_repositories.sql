-- 0011 — repositories linked to a team (WS-3, architecture.md §8.2).
--
-- The asymmetry here is deliberate and worth preserving: **repositories are
-- team-scoped, integrations are workspace-scoped**. A team says which
-- repository it works in, and reaches the credential for it *through* a
-- workspace integration rather than holding one of its own. The alternative —
-- a credential per team — means the same GitHub App installed several times
-- over, and a team quietly acquiring access nobody granted at the workspace
-- level.

CREATE TABLE repositories (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id        text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  -- Where the credential comes from. Workspace-scoped, so linking cannot
  -- introduce a credential the workspace has not already connected.
  integration_id text NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  provider       text NOT NULL CHECK (provider IN ('github', 'gitlab')),
  full_name      text NOT NULL,
  -- What the repository considers its trunk.
  default_branch text NOT NULL DEFAULT 'main',
  -- What agents branch from. Usually the same, deliberately separate: a team
  -- developing against `develop` must not have its agents branch off `main`.
  base_branch    text NOT NULL DEFAULT 'main',
  settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

-- One link per repository per team. A duplicate would index the same code
-- twice and double every retrieval result drawn from it.
CREATE UNIQUE INDEX repositories_unique
  ON repositories (team_id, lower(full_name)) WHERE deleted_at IS NULL;
CREATE INDEX repositories_by_workspace ON repositories (workspace_id, created_at DESC);

ALTER TABLE repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE repositories FORCE ROW LEVEL SECURITY;
CREATE POLICY repositories_tenant ON repositories
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
