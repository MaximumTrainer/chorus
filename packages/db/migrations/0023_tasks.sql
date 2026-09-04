-- 0023 — tasks, their keys and their links (TASK-1, architecture.md §8.2).
--
-- The task is the contract between shaping and delivery, and it is read by a
-- machine as often as by a person. That is why acceptance criteria are
-- structure rather than prose: a pull request renders them as a checklist
-- (CODE-5), and a coding agent satisfies them one at a time. Prose cannot be
-- checked off.

-- The per-team key counter (§4.4).
--
-- A row taken with `SELECT … FOR UPDATE`, deliberately not a sequence. A
-- sequence is global rather than per team, and it leaves gaps when a
-- transaction rolls back — and a task list that jumps from CH-7 to CH-9 makes
-- people go looking for CH-8. The lock serialises concurrent creation within
-- one team and nowhere else.
CREATE TABLE task_counters (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id      text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  -- The next number to hand out. Never decremented, so a key is never reused
  -- even after the task holding it is deleted.
  next_number  integer NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  PRIMARY KEY (workspace_id, team_id)
);

ALTER TABLE task_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY task_counters_tenant ON task_counters
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE TABLE tasks (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id      text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  -- `CH-<n>`, unique per team and stable for the task's life. It appears in
  -- chat, pull request titles and MCP prompts, so a key that changed would
  -- break links people had already sent.
  key          text NOT NULL,
  parent_id    text REFERENCES tasks(id) ON DELETE RESTRICT,
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  -- Rich text, stored as the editor's document model rather than as HTML: a
  -- string of markup cannot be edited collaboratively or diffed meaningfully.
  description  jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- An ordered array of `{ id, text, checked }`. Each item has a stable id
  -- because external systems check them off, and an item addressed by position
  -- would move under them the first time somebody reordered the list.
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags         text[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'todo'
                 CHECK (status IN ('todo', 'in_progress', 'blocked', 'in_review', 'done',
                                   'cancelled')),
  priority     text NOT NULL DEFAULT 'normal'
                 CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  -- Nullable: an unestimated task is an ordinary state, and a default size
  -- would be a number nobody chose being treated as one somebody did.
  size         text CHECK (size IS NULL OR size IN ('XS', 'S', 'M', 'L', 'XL')),
  assignee_id  text REFERENCES users(id) ON DELETE SET NULL,
  -- Manual ordering within a parent, for a board or a tree view (TASK-2).
  position     double precision NOT NULL DEFAULT 0,
  embedding    vector(1536),
  created_by   text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,

  -- A task cannot be its own parent. This catches only the trivial cycle —
  -- the transitive case needs a walk and lives in the service — but it is free
  -- and it closes the one case a direct UPDATE could otherwise create.
  CONSTRAINT tasks_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

-- Unique per team, and per team only: two teams both having a CH-1 is the
-- intended behaviour, because the key is theirs.
CREATE UNIQUE INDEX tasks_key_unique ON tasks (workspace_id, team_id, key);
CREATE INDEX tasks_by_team ON tasks (workspace_id, team_id, status) WHERE deleted_at IS NULL;
CREATE INDEX tasks_by_parent ON tasks (parent_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_by_assignee ON tasks (workspace_id, assignee_id) WHERE deleted_at IS NULL;

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tasks_tenant ON tasks
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- Links between artefacts of any kind (§8.2).
--
-- One table rather than a column per relationship. A `document_id` on tasks, a
-- `task_id` on documents and a `session_id` on both is how a schema acquires a
-- dozen nullable foreign keys and no way to ask "what is this connected to".
CREATE TABLE artefact_links (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_type    text NOT NULL,
  from_id      text NOT NULL,
  to_type      text NOT NULL,
  to_id        text NOT NULL,
  -- What the link means, so a reader is not left inferring it from the types.
  relation     text NOT NULL DEFAULT 'relates_to',
  created_by   text REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- One link per relation per pair. Linking twice is a no-op rather than two
-- rows that render as a duplicate in every view.
CREATE UNIQUE INDEX artefact_links_unique
  ON artefact_links (workspace_id, from_type, from_id, to_type, to_id, relation);
CREATE INDEX artefact_links_from ON artefact_links (workspace_id, from_type, from_id);
CREATE INDEX artefact_links_to ON artefact_links (workspace_id, to_type, to_id);

ALTER TABLE artefact_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE artefact_links FORCE ROW LEVEL SECURITY;
CREATE POLICY artefact_links_tenant ON artefact_links
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
