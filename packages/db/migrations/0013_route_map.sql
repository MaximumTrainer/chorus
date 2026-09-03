-- 0013 — the route map (BRAIN-2 AC3, architecture.md §8.2).
--
-- What turns a URL somebody captured in the browser extension into a file a
-- reader can open (EXT-5), and what lets a prototype start from the real page
-- rather than a blank one (PROTO-1).
--
-- `component_file_id` references `code_files` rather than storing a path,
-- because the point of the map is to reach an *indexed* file — one with
-- symbols and chunks behind it. A path alone would resolve to a string, and a
-- route pointing at a file that was never indexed is a dead end that looks
-- like an answer.

CREATE TABLE route_map (
  id               text PRIMARY KEY,
  workspace_id     text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id    text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  -- Normalised across frameworks — `/blog/:slug`, `/shop/*` — so a consumer
  -- learns one syntax rather than Next.js's, SvelteKit's and Nuxt's.
  route_pattern    text NOT NULL,
  component_file_id text REFERENCES code_files(id) ON DELETE CASCADE,
  -- Kept alongside the reference so a route survives its file being renamed
  -- between the walk and the write, and remains legible in the raw table.
  component_path   text NOT NULL,
  framework        text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- One component per pattern per repository: two files claiming one route is a
-- repository-level ambiguity, and the map has to stay a function to be useful.
CREATE UNIQUE INDEX route_map_unique ON route_map (repository_id, route_pattern);
CREATE INDEX route_map_by_repo ON route_map (workspace_id, repository_id);

ALTER TABLE route_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_map FORCE ROW LEVEL SECURITY;
CREATE POLICY route_map_tenant ON route_map
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
