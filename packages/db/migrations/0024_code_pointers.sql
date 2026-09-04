-- 0024 — code pointers (TASK-3, architecture.md §8.2).
--
-- > A pointer that does not resolve is worse than none: it teaches everyone,
-- > human and machine, to distrust all of them.
--
-- Every column here follows from that. The commit is recorded so a link is
-- reproducible rather than "wherever this file is now"; the source decides what
-- regeneration may overwrite; and a pointer that stops resolving is *marked*
-- rather than deleted, because the last known good commit still tells a reader
-- what it used to point at.

CREATE TABLE code_pointers (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id       text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  path          text NOT NULL,
  symbol_name   text,
  line_start    integer NOT NULL CHECK (line_start >= 1),
  line_end      integer NOT NULL CHECK (line_end >= line_start),
  -- What the pointer was validated against. A link pinned to a branch says
  -- "wherever this file is now", which is the opposite of what a pointer means.
  commit_sha    text,
  -- `manual` is the source with rights: regeneration replaces `generated` and
  -- leaves the rest alone, because a person who corrected a pointer has told us
  -- something the index does not know.
  source        text NOT NULL CHECK (source IN ('generated', 'capture', 'manual')),
  confidence    double precision NOT NULL DEFAULT 0
                  CHECK (confidence >= 0 AND confidence <= 1),
  -- Marked, not deleted (AC5).
  stale_at      timestamptz,
  created_by    text REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- One pointer per place per task. Generating twice must not produce two
  -- identical rows that render as a duplicate citation.
  CONSTRAINT code_pointers_unique_place
    UNIQUE (task_id, repository_id, path, line_start, line_end)
);

CREATE INDEX code_pointers_by_task ON code_pointers (workspace_id, task_id);
CREATE INDEX code_pointers_stale ON code_pointers (workspace_id) WHERE stale_at IS NOT NULL;

ALTER TABLE code_pointers ENABLE ROW LEVEL SECURITY;
ALTER TABLE code_pointers FORCE ROW LEVEL SECURITY;
CREATE POLICY code_pointers_tenant ON code_pointers
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
