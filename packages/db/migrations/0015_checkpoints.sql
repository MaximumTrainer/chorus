-- 0015 — checkpoints (AGENT-3, architecture.md §11.5).
--
-- Where a run stops and asks a human. The table is small; the constraints are
-- the point, because every one of them removes a way for a gate to be passed
-- twice, passed by accident, or passed by nobody.

CREATE TABLE checkpoints (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id         text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  -- The step that is waiting. Recorded so resumption knows where to continue
  -- from, and so a workflow with two gates does not confuse them.
  step_id        text NOT NULL,
  kind           text NOT NULL CHECK (kind IN (
                   'before_create_artefacts',
                   'before_external_write',
                   'before_coding_job',
                   'before_spend_over'
                 )),
  -- Which policy tier produced this mode, so a surprising gate is diagnosable
  -- rather than a shrug. `platform` means nothing was configured.
  policy_source  text NOT NULL CHECK (policy_source IN ('team+workflow', 'team', 'workflow', 'platform')),
  -- The mode that applied, stored rather than derived. `never` produces no row
  -- at all -- there is nothing to decide and nobody to ask -- so the only two
  -- values here are the two that let a run continue.
  mode           text NOT NULL CHECK (mode IN ('auto', 'ask')),
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  -- The action being gated, in full. "A gate you cannot see through is not a
  -- gate" — a summary here would make the person deciding guess.
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- What the decider changed, when they approved with edits. Kept beside the
  -- original rather than overwriting it: the difference between what the agent
  -- proposed and what a human allowed is the record worth having.
  edited_payload jsonb,
  -- AC6. A gate nobody answers must end the run rather than hold it open
  -- forever, and the deadline is a column so expiry is a query, not a timer
  -- living in some process's memory.
  expires_at     timestamptz NOT NULL,
  decided_by     text REFERENCES users(id) ON DELETE SET NULL,
  decision       text CHECK (decision IN ('approve', 'approve_with_edits', 'reject')),
  decision_note  text,
  decided_at     timestamptz,
  -- Where this checkpoint was announced (in-app, email, Slack, Teams), so the
  -- other surfaces can be updated in place once it settles. The transports
  -- arrive with WP-1.2; the column is what they will write to.
  notified_refs  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- A settled checkpoint has a decider and a time; a pending one has neither.
  -- Without this a row could claim to be approved by nobody, which is exactly
  -- the state an accountability record must not be able to reach.
  CONSTRAINT checkpoints_settled_is_attributed CHECK (
    (status = 'pending'  AND decision IS NULL AND decided_at IS NULL) OR
    (status = 'expired'  AND decision IS NULL AND decided_at IS NOT NULL) OR
    (status IN ('approved', 'rejected') AND decision IS NOT NULL AND decided_at IS NOT NULL)
  ),
  -- Edits belong to the decision that made them.
  CONSTRAINT checkpoints_edits_have_a_decision CHECK (
    edited_payload IS NULL OR decision = 'approve_with_edits'
  )
);

-- One checkpoint per gate per run. This is what makes "the first decision
-- wins" (AC4) structural: there is one row to settle, so a second surface
-- decides the same row and finds it already settled, rather than creating a
-- second gate that could disagree with the first.
CREATE UNIQUE INDEX checkpoints_one_per_gate ON checkpoints (run_id, step_id);

-- The two queries this table actually serves: "what is this run waiting on"
-- and "what has expired". The second is partial because a settled checkpoint
-- never expires, and the expiry sweep should not read rows it cannot act on.
CREATE INDEX checkpoints_by_run ON checkpoints (workspace_id, run_id);
CREATE INDEX checkpoints_pending_expiry ON checkpoints (expires_at) WHERE status = 'pending';

-- NFR-3: a new tenant table gets its policy in the same migration.
ALTER TABLE checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoints FORCE ROW LEVEL SECURITY;

CREATE POLICY checkpoints_tenant ON checkpoints
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- A step waiting on a human is not running. Leaving it as `running` would make
-- every paused run look like a stuck one to any query asking what is in
-- flight — and "stuck" is the thing an operator is supposed to act on.
ALTER TABLE run_steps DROP CONSTRAINT run_steps_status_check;
ALTER TABLE run_steps ADD CONSTRAINT run_steps_status_check
  CHECK (status IN ('running', 'waiting', 'succeeded', 'failed', 'skipped'));
