-- 0057 — the record that a workspace was erased (NFR-4 AC5, AC6).
--
-- Erasing a workspace removes everything it owns, its own audit trail included,
-- so the audit of the erasure cannot live in `audit_events`: it would be the
-- last row the erasure deleted. This table is therefore deliberately *not* a
-- tenant table — it carries no `workspace_id` and no row-level security, and it
-- names the workspace in `erased_workspace_id` because the workspace no longer
-- exists. It holds only what an operator needs to answer "was it erased, by
-- whom, when, and was anything left": no workspace content.
CREATE TABLE workspace_erasures (
  id                  text PRIMARY KEY,
  erased_workspace_id text NOT NULL,
  workspace_name      text NOT NULL,
  -- Who asked. Not a foreign key: the record must outlive the person too.
  erased_by           text NOT NULL,
  erased_at           timestamptz NOT NULL DEFAULT now(),
  -- How many workspace-carrying tables the verification pass checked, and any
  -- in which rows remained. An erasure with residue is a failed erasure.
  tables_verified     integer NOT NULL,
  residue             jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX workspace_erasures_by_workspace ON workspace_erasures (erased_workspace_id);
