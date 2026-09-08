-- 0036 — coding jobs (CODE-1, CODE-5, architecture.md §12).
--
-- A coding job spends money, writes to a repository and opens a pull request
-- that colleagues will review. That is why launching is a gated operation with
-- its own requirement rather than a line in a handler, and why this table
-- records who asked for it.

CREATE TABLE coding_jobs (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id       text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  task_id       text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  -- Which adapter ran it (CODE-3). Recorded rather than assumed, because a
  -- workspace changing its default must not rewrite the history of what
  -- actually produced a diff.
  adapter       text NOT NULL,

  -- `queued` and `running` are the non-terminal states; the partial unique
  -- index below depends on exactly this list.
  status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),

  branch            text,
  pull_request_url  text,
  summary           text,
  test_output       text,
  -- Why it failed, in the words the job would use to a person (CODE-3 AC5).
  failure           text,

  -- Nullable: a job is created before its run exists, and a job that never got
  -- as far as a run still has to be explainable.
  run_id        text REFERENCES runs(id) ON DELETE SET NULL,
  -- The human who asked. Kept for attribution on the commit (CODE-5 AC2) and
  -- because "who spent this" is the first question asked of a coding job.
  requested_by  text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

-- CODE-1 AC3: one active job per task, enforced by the database rather than by
-- check-then-insert.
--
-- This is not a defensive nicety. A policy auto-launch (TASK-5) and a user's
-- own click race in practice, and a check-then-insert loses that race silently:
-- both callers read "no active job", both insert, and the task now has two
-- agents editing one branch. A partial unique index makes the second one fail,
-- which the caller can then turn into "here is the job you already have".
CREATE UNIQUE INDEX coding_jobs_one_active
  ON coding_jobs (task_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX coding_jobs_by_task ON coding_jobs (workspace_id, task_id, created_at DESC);
CREATE INDEX coding_jobs_by_team ON coding_jobs (workspace_id, team_id, created_at DESC);

-- NFR-3: a new tenant table gets its policy in the same migration.
ALTER TABLE coding_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE coding_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY coding_jobs_tenant ON coding_jobs
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
