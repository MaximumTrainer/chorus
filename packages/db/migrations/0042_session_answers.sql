-- 0042 — answers to clarifying questions, as session state (CHAT-4, architecture.md §11.3).
--
-- A clarifying question is answered once and the answer matters to every later
-- turn: it must not be re-asked (AC3), and it must shape what the agent does
-- next (AC4). Prose in the transcript cannot be relied on for either — a later
-- turn would have to re-read and re-interpret the conversation. So an answer is
-- structured state, keyed by the subject it settles, which is exactly the key
-- the clarifier drops a re-ask against.

CREATE TABLE session_answers (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id   text NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  -- The subject the answer settles, stored normalised (lower-case, alphanumerics)
  -- so the next turn's suppression check is a plain key comparison.
  subject      text NOT NULL,
  -- The question as asked and the answer given, kept for the transcript and so a
  -- later workflow can show why it believes what it does.
  question     text NOT NULL,
  answer       text NOT NULL,
  -- The person who answered. Null-able because an answer may arrive from a
  -- surface where the user is not a Chorus user row.
  answered_by  text REFERENCES users(id) ON DELETE SET NULL,
  answered_at  timestamptz NOT NULL DEFAULT now()
);

-- One answer per subject per session: answering again replaces the earlier one
-- rather than leaving two the next turn would have to choose between.
CREATE UNIQUE INDEX session_answers_subject
  ON session_answers (workspace_id, session_id, subject);
CREATE INDEX session_answers_by_session ON session_answers (workspace_id, session_id);

-- NFR-3: a new tenant table gets its policy in the same migration.
ALTER TABLE session_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_answers FORCE ROW LEVEL SECURITY;
CREATE POLICY session_answers_tenant ON session_answers
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
