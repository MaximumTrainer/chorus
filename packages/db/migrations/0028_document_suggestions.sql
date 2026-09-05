-- DOC-3 — AI editing as accept/reject suggestions.
--
-- Suggestions live **beside** the document, never inside it. That is the whole
-- requirement: until somebody accepts one, the document must be byte-identical
-- to what it was, through every path a reader has — the API, the export, MCP.
--
-- The alternative was marks inside the CRDT, which is what the requirement's
-- implementation note suggests and what the editor will eventually render. It
-- is rejected here for a reason worth writing down: text inside the document
-- has to be filtered out by *every* consumer — the export, the prompt builder,
-- the wiki compiler, the search indexer — and a guarantee that holds only while
-- everyone remembers to filter is not a guarantee. Outside the document, AC1
-- and AC2 are true by construction rather than by vigilance.
--
-- A suggestion is anchored by its text, not by a position. A position goes
-- stale the moment anyone types anywhere before it; the text goes stale only
-- when the text itself changes, which is exactly when a suggestion *should*
-- stop applying (AC5).
CREATE TABLE document_suggestion_sets (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id   text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_by    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instruction   text NOT NULL CHECK (length(instruction) BETWEEN 1 AND 2000),
  -- The selection this was asked about, as offsets into the exported document.
  -- Null means the whole document was in scope.
  selection_from integer,
  selection_to   integer,
  -- `generating` is a real state: in a deployment the model call is enqueued,
  -- so a set exists before it has anything in it.
  status        text NOT NULL DEFAULT 'generating'
                CHECK (status IN ('generating', 'ready', 'failed')),
  -- Why it failed, in words a person can act on (AC6). "The model failed" and
  -- "the model had nothing to suggest" are different answers, and only one of
  -- them is worth offering a retry for.
  error         text,
  run_id        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_suggestions (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  set_id          text NOT NULL REFERENCES document_suggestion_sets(id) ON DELETE CASCADE,
  -- The order the model proposed them in, which is the order a reader works
  -- through them.
  sequence        integer NOT NULL,
  -- The anchor. Held as the text itself so "does this still apply" is answered
  -- against the document as it is now, not against a snapshot.
  original_text   text NOT NULL,
  replacement_text text NOT NULL,
  -- Why the model proposed it. Shown beside the suggestion, because an edit
  -- somebody is asked to approve without a reason is one they approve blindly.
  reason          text,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'rejected', 'stale')),
  decided_by      text REFERENCES users(id) ON DELETE SET NULL,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX document_suggestion_sets_document ON document_suggestion_sets (document_id, created_at DESC);
CREATE UNIQUE INDEX document_suggestions_order ON document_suggestions (set_id, sequence);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_suggestion_sets', 'document_suggestions'] LOOP
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
