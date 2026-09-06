-- DOC-6 — where a proposed tree came from.
--
-- A separate migration rather than an edit to 0032, which has already been
-- applied on the remote: the runner refuses a migration whose checksum changed
-- (NFR-1 AC5, ADR-0016), and it is right to. Editing it would leave two
-- deployments claiming the same schema version with different schemas.
--
-- Nullable, because a proposal can also come from a chat session with no
-- document behind it. The column answers "where did these tasks come from?"
-- without reading the run, which matters because traces are prunable and this
-- link is not.
ALTER TABLE structure_proposals
  ADD COLUMN source_document_id text REFERENCES documents(id) ON DELETE SET NULL;

CREATE INDEX structure_proposals_by_document
  ON structure_proposals (source_document_id)
  WHERE source_document_id IS NOT NULL;
