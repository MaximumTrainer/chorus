-- 0014 — workflows, runs and their steps (AGENT-1, architecture.md §8.2, §11).
--
-- Durable workflow state lives in Postgres, not in the queue (ADR-0004). BullMQ
-- moves work; it does not remember what a run has already done. A worker killed
-- mid-run must resume from the last completed step, which needs a record the
-- broker does not hold.
--
-- The load-bearing column is `run_steps.input_hash`. Resumption is not "start
-- again from step four" — it is "step four already ran with exactly this input,
-- so do not run it again". A sequence number alone cannot say that, and a step
-- re-executed on resume is a duplicate artefact or a second pull request.

CREATE TABLE workflows (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  version       integer NOT NULL,
  -- The whole definition, as loaded and validated. Stored rather than read from
  -- disk at run time so a run can be replayed against the definition it
  -- actually used, even after the file changed.
  definition    jsonb NOT NULL,
  -- Null for a built-in shipped with the platform; set for a team's own.
  team_id       text REFERENCES teams(id) ON DELETE CASCADE,
  source        text NOT NULL DEFAULT 'built_in' CHECK (source IN ('built_in', 'workspace')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

-- A version is immutable once it exists: editing a definition publishes a new
-- version, so a run in flight can keep referring to the one it started with
-- (AC4).
CREATE UNIQUE INDEX workflows_version_key ON workflows (workspace_id, name, version);

CREATE TABLE runs (
  id               text PRIMARY KEY,
  workspace_id     text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id          text REFERENCES teams(id) ON DELETE SET NULL,
  workflow_name    text NOT NULL,
  -- Pinned at creation (AC4). A workflow edited mid-run must not change what
  -- the run is doing halfway through, and the recorded version is what makes a
  -- trace explicable months later.
  workflow_version integer NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'running', 'waiting_human', 'succeeded',
                                       'failed', 'stopped')),
  trigger          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The person the run acts for. Every tool call is authorised as them, never
  -- as the platform (AGENT-5 AC5).
  started_by       text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  session_id       text,
  -- Which tier resolved to which model, recorded so a run's cost and quality
  -- are attributable after the fact (NFR-2 AC3).
  model_config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_cents       integer NOT NULL DEFAULT 0,
  tokens_in        integer NOT NULL DEFAULT 0,
  tokens_out       integer NOT NULL DEFAULT 0,
  error            text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);

CREATE INDEX runs_recent ON runs (workspace_id, started_at DESC);
CREATE INDEX runs_resumable ON runs (workspace_id, status) WHERE status IN ('pending', 'running');

CREATE TABLE run_steps (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id       text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  -- The step's id from the definition, so a resumed run matches by *identity*
  -- rather than by position — inserting a step into a definition must not make
  -- a resuming run replay the wrong one.
  step_id      text NOT NULL,
  step_type    text NOT NULL,
  status       text NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  -- What makes resumption safe. A completed step with an unchanged input hash
  -- is not re-executed; a changed hash means the step is genuinely different
  -- work and must run.
  input_hash   text NOT NULL,
  output       jsonb,
  error        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

-- One row per step per run. The unique index is what makes "has this already
-- run" a question the database answers, rather than a read-then-write race
-- between two workers that both picked up the same run.
CREATE UNIQUE INDEX run_steps_unique ON run_steps (run_id, step_id);
CREATE INDEX run_steps_ordered ON run_steps (run_id, seq);

CREATE TABLE run_events (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id       text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  -- architecture.md §11.6. The substrate for the trace UI and, later, the
  -- evaluation harness.
  kind         text NOT NULL CHECK (kind IN ('model_call', 'tool_call', 'checkpoint',
                                             'artefact', 'error', 'routing')),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX run_events_ordered ON run_events (run_id, seq);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflows', 'runs', 'run_steps', 'run_events'] LOOP
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
