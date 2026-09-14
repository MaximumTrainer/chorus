-- 0037 — an answer that stopped halfway says so (CHAT-2 AC3).
--
-- A reader who hangs up mid-turn leaves a partial answer, and the partial is
-- kept: what they saw is what the transcript should show, and throwing it away
-- to keep the table tidy loses the only record of what the agent had said.
--
-- But a partial that is stored like a complete one is a lie the transcript
-- tells every reader afterwards. "The parser does three jobs," reads as a
-- finished thought; nothing distinguishes it from an answer that ended there
-- on purpose. Worse, it is the version a later turn would quote back as
-- context, and a model given a truncated answer as though it were whole has
-- been misled by its own history.
--
-- A column rather than a flag inside `content`, because it is asked as a
-- question — show me the turns that were cut off — and a predicate on jsonb
-- is one nobody writes by accident.
ALTER TABLE messages
  ADD COLUMN interrupted boolean NOT NULL DEFAULT false;

-- No RLS policy is added here: `messages` is already a tenant table with a
-- policy from 0026, and a column inherits it. NFR-3's suite enumerates tables,
-- not columns, and would report a false gap if this said otherwise.
