-- 0058 — embeddings cached by content hash (BRAIN-1 AC6, AC2).
--
-- Signals are immutable (AC3, 0056), so their vectors are not written onto
-- them. Instead each signal carries the hash of its text, set once when the row
-- is inserted, and a workspace-scoped cache holds one vector per (model, hash).
-- A signal finds its vector by its hash, so unchanged content never costs a
-- provider call: not on a re-run, not for a new version that only changed who
-- may see it, not for a revert, not for two items that say the same thing.
--
-- The hash is SHA-256 of the UTF-8 text, hex — exactly `contentHash` in
-- packages/llm, so the two can never disagree. It is set by a BEFORE INSERT
-- trigger rather than a generated column because the UTF-8 conversion Postgres
-- needs is not immutable; a trigger that fires only on insert keeps the row
-- unchanged afterwards.
ALTER TABLE signals ADD COLUMN content_hash text;
UPDATE signals SET content_hash = encode(sha256(convert_to(coalesce(text, ''), 'UTF8')), 'hex');
ALTER TABLE signals ALTER COLUMN content_hash SET NOT NULL;

CREATE FUNCTION signals_set_content_hash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.content_hash := encode(sha256(convert_to(coalesce(NEW.text, ''), 'UTF8')), 'hex');
  RETURN NEW;
END
$$;

CREATE TRIGGER signals_content_hash BEFORE INSERT ON signals
  FOR EACH ROW EXECUTE FUNCTION signals_set_content_hash();

CREATE INDEX signals_by_content_hash ON signals (workspace_id, content_hash);

-- Per workspace, deliberately: a cache shared across tenants would let a hit —
-- a missing provider call, a faster response — reveal that another tenant holds
-- the same words. The model is part of the key: one model's vector means
-- nothing to another.
CREATE TABLE embedding_cache (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  model        text NOT NULL,
  content_hash text NOT NULL,
  embedding    vector(1536) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX embedding_cache_key ON embedding_cache (workspace_id, model, content_hash);
-- The vector half of signal retrieval searches here and joins back by hash.
CREATE INDEX embedding_cache_vector ON embedding_cache USING hnsw (embedding vector_cosine_ops);

ALTER TABLE embedding_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY embedding_cache_tenant ON embedding_cache
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
