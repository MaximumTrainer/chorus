-- 0009 — signals: the immutable record of what a source told us (INT-1 AC2, AC6).
--
-- A signal is raw inbound data with provenance, never a derived artefact. It is
-- written once and never updated, which is what lets ingestion be idempotent:
-- replaying a webhook delivery or re-serving a page produces no new rows and
-- changes no existing ones.
--
-- The uniqueness key is `(integration_id, external_id, kind)`, per
-- architecture.md §8.5. `integration_id` rather than `workspace_id` because two
-- integrations of the same kind in one workspace — two GitHub organisations —
-- legitimately carry colliding external ids, and keying on the workspace would
-- silently drop one organisation's data.
--
-- Enrichment that BRAIN-1 and BRAIN-4 add later — `tsv`, chunking, embeddings —
-- is deliberately not here. INT-1 owns getting the row in exactly once; making
-- it searchable is a different requirement with a different test.

CREATE TABLE signals (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id text NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  -- Denormalised from the integration so a query by source needs no join; a
  -- signal outlives nothing, so this cannot drift.
  source         text NOT NULL,
  external_id    text NOT NULL,
  kind           text NOT NULL,
  text           text,
  -- Fields the connector lifted out of `raw` because they are worth querying.
  structured     jsonb,
  author         text,
  author_display text,
  occurred_at    timestamptz NOT NULL,
  url            text,
  -- Captured at ingest and re-checked at retrieval (architecture.md §10.1).
  -- A signal whose scope was not captured here can never be safely surfaced.
  permissions    jsonb NOT NULL,
  -- The untouched source payload, so a mapping bug is diagnosable after the
  -- fact rather than only reproducible against a live source.
  raw            jsonb,
  ingested_at    timestamptz NOT NULL DEFAULT now()
);

-- Idempotency, enforced by the database rather than by a read-then-write in the
-- application, which is a race under concurrent sync and webhook delivery.
CREATE UNIQUE INDEX signals_dedup ON signals (integration_id, external_id, kind);
CREATE INDEX signals_recent ON signals (workspace_id, occurred_at DESC);
CREATE INDEX signals_by_source ON signals (workspace_id, source, occurred_at DESC);

ALTER TABLE signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE signals FORCE ROW LEVEL SECURITY;
CREATE POLICY signals_tenant ON signals
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
