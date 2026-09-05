-- DOC-5 — version history.
--
-- > Restore must be additive — destroying history to undo is how people lose
-- > work twice.
--
-- So nothing here is ever updated in place: a restore writes a *new* version,
-- and the state it replaced is written as one too. Undoing an undo is a thing
-- people need, and it is only possible if the moment before the restore was
-- captured — nobody snapshots the document they are about to lose.
CREATE TABLE document_versions (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id  text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- Monotonic per document, so "the version before this one" is answerable
  -- without comparing timestamps that can tie.
  sequence     integer NOT NULL,
  -- The CRDT state, which is what a restore replays.
  snapshot     bytea NOT NULL,
  -- The same content rendered, which is what a diff reads. Derived, and kept
  -- because diffing would otherwise decode every snapshot in the list — and
  -- because a diff should not change when the renderer does.
  body_md      text NOT NULL,
  cause        text NOT NULL CHECK (cause IN
                 ('manual', 'scheduled', 'approval', 'suggestions_accepted',
                  'restore', 'pre_restore')),
  label        text,
  created_by   text REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX document_versions_order ON document_versions (document_id, sequence);
CREATE INDEX document_versions_recent ON document_versions (document_id, created_at DESC);

ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY document_versions_tenant ON document_versions
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
