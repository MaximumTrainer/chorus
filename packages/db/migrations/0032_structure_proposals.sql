-- CHAT-5 — the confirmation gate.
--
-- > The guarantee that nothing is written before confirmation must be
-- > structural — enforced by the data model — and not merely a UI convention.
--
-- Which is what this table is for. The proposed tree lives here as data, in
-- one `tree` column, and *not* as rows in `tasks`. A design that wrote the
-- tasks first and hid them behind a `status` column would make the guarantee a
-- query away from being wrong: every list, count, search, export and tracker
-- push would have to remember the filter, and the one that forgot would be the
-- one that flooded somebody's board.
CREATE TABLE structure_proposals (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id      text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  session_id   text REFERENCES chat_sessions(id) ON DELETE SET NULL,
  -- The run that proposed it, so a reader can reach the trace that explains
  -- why these tasks and not others.
  run_id       text REFERENCES runs(id) ON DELETE SET NULL,
  -- What the agent proposed, exactly as proposed. Kept even after an edited
  -- confirmation, because AC3 wants the diff and a diff needs both sides.
  tree         jsonb NOT NULL,
  -- What was actually confirmed, when it differs from `tree`.
  confirmed_tree jsonb,
  status       text NOT NULL DEFAULT 'proposed'
                 CHECK (status IN ('proposed', 'confirmed', 'edited_and_confirmed', 'rejected')),
  -- Why it was rejected, in the person's words, for the next turn to read.
  feedback     text,
  decided_by   text REFERENCES users(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX structure_proposals_by_session ON structure_proposals (session_id, created_at DESC);
CREATE INDEX structure_proposals_open ON structure_proposals (workspace_id, team_id)
  WHERE status = 'proposed';

-- The tasks a confirmation produced, so a second confirmation can return the
-- first one's answer instead of building a second tree (AC5). A plain column
-- on `tasks` would answer "which proposal made this task" but not "what did
-- that confirmation return", which is the question a retried request asks.
CREATE TABLE structure_proposal_tasks (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  proposal_id  text NOT NULL REFERENCES structure_proposals(id) ON DELETE CASCADE,
  task_id      text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- The node it came from, so an edited tree can be compared to what exists.
  node_key     text NOT NULL,
  PRIMARY KEY (proposal_id, task_id)
);

CREATE INDEX structure_proposal_tasks_by_task ON structure_proposal_tasks (task_id);

ALTER TABLE structure_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE structure_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY structure_proposals_tenant ON structure_proposals
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE structure_proposal_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE structure_proposal_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY structure_proposal_tasks_tenant ON structure_proposal_tasks
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
