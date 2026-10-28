-- 0041 — lexical search over tasks and documents (BRAIN-4, architecture.md §10.5).
--
-- Retrieval widens from code to artefacts. The lexical half needs an indexed
-- tsvector per table, generated from the row so it can never drift from what
-- it indexes, as code_chunks.search is (0021).
--
-- A task's description and acceptance criteria are JSON, and indexing the JSON
-- as text would index its keys ("type", "paragraph", "checked") as if somebody
-- had written them. So only the string values under `text` keys are taken, which
-- is where the editor's text nodes and each criterion's wording live.
--
-- The 'simple' configuration, for the reason 0021 gives: the terms people
-- search for are identifiers and product words that a stemmer mangles.

ALTER TABLE tasks
  ADD COLUMN search tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      key || ' ' || title || ' ' ||
      jsonb_path_query_array(acceptance_criteria, 'strict $.**.text')::text || ' ' ||
      jsonb_path_query_array(description, 'strict $.**.text')::text)
  ) STORED;

CREATE INDEX tasks_search ON tasks USING gin (search) WHERE deleted_at IS NULL;

ALTER TABLE documents
  ADD COLUMN search tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple', title || ' ' || body_md_cache)
  ) STORED;

CREATE INDEX documents_search ON documents USING gin (search) WHERE deleted_at IS NULL;
