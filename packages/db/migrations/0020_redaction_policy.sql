-- 0020 — the workspace redaction level (NFR-11, AGENT-4 AC3).
--
-- A column rather than a table: there is exactly one of these per workspace,
-- it is read on every run, and a table would add a join to the hot path for a
-- single enum.
--
-- The default is `structural` — bodies replaced by a hash and a length, with
-- the structural record complete. This settles architecture.md §25's open
-- decision 10 in the direction that can be undone: a workspace that wants full
-- bodies opts in and has them from that moment, whereas a workspace that
-- discovers it has been storing customer prompts for six months cannot
-- un-store them.
ALTER TABLE workspaces ADD COLUMN redaction_level text NOT NULL DEFAULT 'structural'
  CHECK (redaction_level IN ('none', 'structural', 'full'));
