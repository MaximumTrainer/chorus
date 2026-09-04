-- 0021 — what retrieval needs (BRAIN-4, architecture.md §10.5).
--
-- Hybrid search is lexical *and* vector, run in parallel and fused. Each half
-- needs its own index, and neither is optional: a vector-only search on a rare
-- identifier is close to a coin toss, because an embedding of a name the model
-- has never seen carries almost no signal; a lexical-only search misses every
-- paraphrase, which is most of how people actually ask.

-- The lexical half. Generated rather than maintained by a trigger, so it cannot
-- drift from the text it indexes — a stale search column is a chunk that
-- quietly stops being findable while every other sign says it was indexed.
--
-- `simple` rather than `english`: this is code. Stemming `parseInvoices` to
-- `parseinvoic` helps nobody, and the identifiers people search for are exactly
-- the tokens a language-aware configuration would mangle.
ALTER TABLE code_chunks
  ADD COLUMN search tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(symbol_name, '') || ' ' || text)
  ) STORED;

CREATE INDEX code_chunks_search ON code_chunks USING gin (search);

-- Identifiers are compounds — `parseInvoiceLine` is three words a reader sees
-- and one token the parser produces — so trigrams catch the substring searches
-- full-text cannot. This is what makes searching for "invoice" find
-- `parseInvoiceLine`.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX code_chunks_symbol_trgm ON code_chunks USING gin (symbol_name gin_trgm_ops);

-- The vector half. HNSW rather than IVFFlat: it needs no training step, so an
-- index built over an empty table stays correct as the corpus grows, which is
-- exactly the situation a fresh workspace is in. Cosine distance, matching how
-- the embeddings are normalised.
CREATE INDEX code_chunks_embedding ON code_chunks
  USING hnsw (embedding vector_cosine_ops);

-- AC4: bundles are persisted and reproducible.
--
-- The bundle records *references*, not copies. A copy would drift from the
-- chunk it cited the moment the file was re-indexed, and a citation that
-- silently stops matching its source is worse than one that is honestly
-- missing. What is stored is enough to resolve every fragment again, plus the
-- query and parameters that produced it — so "why did it retrieve that" is
-- answerable months later.
CREATE TABLE context_bundles (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Who it was assembled for. Retrieval is permission-filtered, so a bundle is
  -- only meaningful alongside the identity it was filtered against.
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id      text REFERENCES teams(id) ON DELETE SET NULL,
  query        text NOT NULL,
  -- k, kinds, expand, filters — everything needed to run it again.
  parameters   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Ordered citation ids and the chunk each resolves to.
  fragments    jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- How many the caller was permitted to see, which is what makes "there is
  -- more" honest without revealing what was filtered out.
  considered   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX context_bundles_recent ON context_bundles (workspace_id, created_at DESC);

-- NFR-3: a new tenant table gets its policy in the same migration.
ALTER TABLE context_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_bundles FORCE ROW LEVEL SECURITY;

CREATE POLICY context_bundles_tenant ON context_bundles
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
