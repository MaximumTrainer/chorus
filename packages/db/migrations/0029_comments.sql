-- DOC-4 — anchored comments and threads.
--
-- A thread is anchored to the **text it quotes**, not to a position. A position
-- has to be rebased against every edit anybody makes before it, and gets that
-- wrong silently; a quotation is located afresh whenever the thread is read, so
-- an edit elsewhere in the document cannot move it at all.
--
-- The quotation is kept whatever happens to the document. It costs a column and
-- it is the only way to render an orphan usefully: "this was about *this
-- sentence*, which is gone" is something a reader can act on, and a comment
-- with no context is not.
--
-- There is deliberately no `orphaned` column. Whether a thread still has its
-- text is a fact about the document as it is *now*, and a stored flag would be
-- a second answer to that question — right until somebody edits the document
-- without going through whatever code remembers to update it.
CREATE TABLE comment_threads (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id   text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- The anchor.
  quote         text NOT NULL CHECK (length(quote) BETWEEN 1 AND 4000),
  -- Enough preceding text to tell two identical quotations apart. Null when
  -- the quotation was unique when the comment was made.
  quote_prefix  text,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by   text REFERENCES users(id) ON DELETE SET NULL,
  resolved_at   timestamptz,
  created_by    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE comments (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id    text NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  author_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body         text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 10000),
  -- Who was mentioned, as user ids. Stored rather than parsed out of the body
  -- on demand: the body is prose somebody may edit, and a mention that stops
  -- being detectable is a notification nobody can explain the absence of.
  mentions     text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX comment_threads_document ON comment_threads (document_id, created_at);
CREATE INDEX comments_thread ON comments (thread_id, created_at);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['comment_threads', 'comments'] LOOP
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
