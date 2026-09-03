-- 0019 — the spend ledger (AGENT-4 AC4, NFR-2, architecture.md §8.2).
--
-- One row per model call. `runs.cost_cents` is a *cache* of the sum, and this
-- is the record — which is the right way round, because a displayed cost that
-- cannot be reconciled against the calls that produced it is a number nobody
-- can defend when it is questioned.
--
-- Written as calls happen, not at run completion. A crashed run's spend is
-- still spend, and buffering would lose exactly the case where somebody wants
-- to know where the money went.

CREATE TABLE spend_ledger (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id      text REFERENCES teams(id) ON DELETE SET NULL,
  -- Nullable: an embedding for indexing, or a routing classification, belongs
  -- to no run. Attributing those to a run would make a run's cost wrong in the
  -- other direction.
  run_id       text REFERENCES runs(id) ON DELETE SET NULL,
  provider     text NOT NULL,
  -- The concrete model, recorded here and nowhere else in application code.
  -- This is data about what happened, not a choice made in source (ADR-0015).
  model        text NOT NULL,
  purpose      text NOT NULL,
  tokens_in    integer NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out   integer NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  -- Integer cents. Floating-point money accumulates error precisely when there
  -- are many small amounts, which is exactly the shape of model spend.
  cost_cents   integer NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  latency_ms   integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  at           timestamptz NOT NULL DEFAULT now()
);

-- The three questions asked of it: what did this run cost, what did this team
-- spend this month, and what is this workspace's total.
CREATE INDEX spend_ledger_by_run ON spend_ledger (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX spend_ledger_by_team ON spend_ledger (workspace_id, team_id, at DESC);
CREATE INDEX spend_ledger_recent ON spend_ledger (workspace_id, at DESC);

-- NFR-3: a new tenant table gets its policy in the same migration.
ALTER TABLE spend_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE spend_ledger FORCE ROW LEVEL SECURITY;

CREATE POLICY spend_ledger_tenant ON spend_ledger
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- AGENT-4 AC2: reproducibility is pinned per run. The model config a run
-- resolved is already on `runs`; these record which prompt template produced
-- each model call, so a result can be replayed against the exact text that
-- produced it rather than against whatever the file says today.
ALTER TABLE run_events ADD COLUMN prompt_id text;
ALTER TABLE run_events ADD COLUMN prompt_version integer;
ALTER TABLE run_events ADD COLUMN prompt_hash text;
