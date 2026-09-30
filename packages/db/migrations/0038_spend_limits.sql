-- 0038 — spend limits (NFR-8, #168, architecture.md §9.3).
--
-- What the spend guard reads. One row for the workspace (team_id NULL) and at
-- most one per team; both bind, and the tighter one wins (NFR-8 AC4). A team
-- limit is not an allowance carved out of the workspace's: a team under its own
-- limit inside a workspace over its limit is still refused.
--
-- Soft and hard are separate columns rather than two rows because they are one
-- decision about one budget: a soft limit is the point at which someone is
-- asked, and a hard limit is the point at which nobody can say yes. Either may
-- be absent, and a row with neither is refused as a limit that limits nothing.
--
-- There is deliberately no route that writes this table yet. The screen for
-- setting limits is WS-7 (#22); the guard reading them is not blocked on it.

CREATE TABLE spend_limits (
  id               text PRIMARY KEY,
  workspace_id     text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id          text REFERENCES teams(id) ON DELETE CASCADE,
  -- The window spend is summed over, starting at the beginning of the current
  -- UTC day or month. Calendar periods rather than rolling ones, because a
  -- budget somebody sets is a budget for "this month", and a rolling window
  -- makes the answer to "how much is left" change overnight with no spend.
  period           text NOT NULL DEFAULT 'month' CHECK (period IN ('day', 'month')),
  -- Integer cents, like the ledger they are compared against.
  soft_limit_cents integer CHECK (soft_limit_cents IS NULL OR soft_limit_cents >= 0),
  hard_limit_cents integer CHECK (hard_limit_cents IS NULL OR hard_limit_cents >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT spend_limits_limit_something
    CHECK (soft_limit_cents IS NOT NULL OR hard_limit_cents IS NOT NULL)
);

-- One limit per scope. COALESCE because NULLs never compare equal, and a plain
-- unique index would admit any number of workspace-wide rows — leaving which
-- one binds to whichever the planner happened to read first.
CREATE UNIQUE INDEX spend_limits_scope_key
  ON spend_limits (workspace_id, coalesce(team_id, ''));

-- NFR-3: a new tenant table gets its policy in the same migration.
ALTER TABLE spend_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE spend_limits FORCE ROW LEVEL SECURITY;

CREATE POLICY spend_limits_tenant ON spend_limits
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
