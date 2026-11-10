-- 0049 — a document's link to the external object that mirrors it (INT-9 AC6).
--
-- The sink publishes a Chorus document to a Confluence page and stamps a
-- `chorus-doc-id` property on the page. This is the reverse, kept in Chorus: the
-- document's link to that page, so a two-way sync can tell, when the page
-- changes, which document it belongs to — and raise a suggested change on the
-- document rather than overwriting it (DOC-8's one-way-by-default, two-way opt
-- in). A tenant table like every other, scoped by the same policy.
CREATE TABLE document_external_links (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id   text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- e.g. `confluence:page`. Namespaced so one document could mirror to more
  -- than one surface later without the column meaning two things.
  external_kind text NOT NULL,
  external_id   text NOT NULL,
  -- Whether edits on the external side flow back as suggestions. False by
  -- default: the push is one-way until a team opts in (DOC-8).
  two_way       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One link per external object, so re-publishing updates it rather than growing
-- a second row that a reconcile would then have to choose between.
CREATE UNIQUE INDEX document_external_links_unique
  ON document_external_links (workspace_id, external_kind, external_id);
CREATE INDEX document_external_links_by_document
  ON document_external_links (workspace_id, document_id);

ALTER TABLE document_external_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_external_links FORCE ROW LEVEL SECURITY;
CREATE POLICY document_external_links_tenant ON document_external_links
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
