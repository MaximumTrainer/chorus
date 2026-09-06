-- DOC-6 AC2 — a task links to the *section* it came from, not only the document.
--
-- > Section-level back-links are what make the resulting tasks auditable: a
-- > reviewer can ask "where did this come from?" and get an exact answer, and a
-- > later change to that section can flag the task as possibly stale.
--
-- The document alone answers a question the reviewer already had. `detail`
-- carries what makes the link checkable — the section keys — as data rather
-- than as a convention encoded in `relation`, because a relation string that
-- has to be parsed is one every reader parses slightly differently.
ALTER TABLE artefact_links
  ADD COLUMN detail jsonb NOT NULL DEFAULT '{}'::jsonb;
