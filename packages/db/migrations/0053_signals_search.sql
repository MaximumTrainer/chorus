-- 0053 — signals become searchable (BRAIN-4, retrieval widened to signals).
--
-- 0009 deliberately left this out: INT-1 owned getting the row in exactly once,
-- and making it searchable is a different requirement — this one. A generated
-- `search` tsvector over the signal's prose, indexed with GIN, is the same
-- shape the artefacts got in 0041, so the lexical half reaches an index rather
-- than scanning. A signal with no prose (a commit, a deployment, a metric
-- change) has an empty vector and simply never matches a text query.
--
-- Permission is not indexed here: it is a predicate on `permissions` applied in
-- the retrieval query itself (architecture.md §10.5), because a restricted
-- signal a caller may not see must never be a candidate — not filtered from the
-- results, where its absence would still leak through a count.
ALTER TABLE signals
  ADD COLUMN search tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text, ''))) STORED;

CREATE INDEX signals_search ON signals USING gin (search);
