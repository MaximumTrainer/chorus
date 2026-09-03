-- 0012 — the code index (BRAIN-2, architecture.md §8.2, §10.2).
--
-- Code awareness is what makes every downstream feature specific rather than
-- generic: pointers on tasks, briefs for coding agents, mapping a captured URL
-- to a component. Four tables, and the shape of each is driven by one question
-- it has to answer quickly.
--
-- `repo_index_runs`  which commit does the index represent, and what did the
--                    last run do? (AC1, AC2)
-- `code_files`       what is in the repository, and has this file changed?
-- `code_symbols`     where is this thing defined?
-- `code_chunks`      what code is about this, semantically? (BRAIN-4)
--
-- Embeddings are deliberately nullable. Indexing structure and embedding text
-- are separable costs, and a file that is parsed but not yet embedded is a
-- useful intermediate state rather than a broken one.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE repo_index_runs (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'succeeded', 'failed')),
  -- The commit this index represents. AC1 requires the index to report it, so
  -- a consumer can tell whether a citation is current.
  commit_sha    text,
  -- What the run did, so AC2's "reports the counts" is answerable without
  -- re-deriving it: files seen, parsed, skipped, chunks written, reused.
  stats         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Files that would not parse, with reasons (AC7). A list rather than a count,
  -- because "which files are we blind to" is the question worth asking.
  failures      jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE INDEX repo_index_runs_recent
  ON repo_index_runs (workspace_id, repository_id, started_at DESC);

CREATE TABLE code_files (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  path          text NOT NULL,
  lang          text,
  size_bytes    integer NOT NULL DEFAULT 0,
  -- SHA-256 of the contents. The whole of incremental re-indexing (AC2): an
  -- unchanged hash means nothing downstream needs redoing.
  content_hash  text NOT NULL,
  commit_sha    text,
  -- Recorded rather than thrown (AC7), so a file we are blind to is visible.
  parse_error   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX code_files_unique ON code_files (repository_id, path);
CREATE INDEX code_files_by_repo ON code_files (workspace_id, repository_id);

CREATE TABLE code_symbols (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id       text NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  name          text NOT NULL,
  line_start    integer NOT NULL,
  line_end      integer NOT NULL,
  signature     text
);

-- "Where is `makeWidget` defined?" is the question this table exists for.
CREATE INDEX code_symbols_by_name ON code_symbols (workspace_id, name);
CREATE INDEX code_symbols_by_file ON code_symbols (file_id);

CREATE TABLE code_imports (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id       text NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
  -- The specifier as written. Resolution to a file is deliberately out of
  -- scope (the issue excludes cross-repository symbol resolution), and an
  -- unresolved specifier is still enough to build the import graph within one
  -- repository.
  specifier     text NOT NULL
);

CREATE INDEX code_imports_by_file ON code_imports (file_id);
CREATE INDEX code_imports_by_specifier ON code_imports (workspace_id, specifier);

CREATE TABLE code_chunks (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id       text NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
  text          text NOT NULL,
  -- 1-based and inclusive, matching how a citation is written. What makes a
  -- retrieval result something a reader can actually open.
  line_start    integer NOT NULL,
  line_end      integer NOT NULL,
  symbol_name   text,
  symbol_kind   text,
  -- Nullable: parsing and embedding are separable costs, and a chunk awaiting
  -- its vector is a useful intermediate state.
  embedding     vector(1536),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX code_chunks_by_file ON code_chunks (file_id);
CREATE INDEX code_chunks_by_repo ON code_chunks (workspace_id, file_id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'repo_index_runs', 'code_files', 'code_symbols', 'code_imports', 'code_chunks'
  ] LOOP
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
