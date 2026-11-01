-- 0044 — the entity graph's nodes, aliases and evidence (BRAIN-3).
--
-- The graph is what lets retrieval answer "what else is related to this" rather
-- than only "what text looks similar". This migration is its first half: the
-- entities themselves, the names they also go by, and — the thing that keeps
-- the graph honest — the evidence each one rests on. Edges and review items
-- arrive with the LLM pass that produces them.
--
-- Every derived row records `extractor_version`. Without it, changing an
-- extraction prompt silently rewrites history, and nobody can tell a new belief
-- from a corrected one (BRAIN-3 AC5).

CREATE TABLE entities (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN (
                   'ticket', 'person', 'repo', 'feature', 'component', 'topic',
                   'page', 'metric', 'experiment', 'design', 'decision'
                 )),
  -- The source's own identifier, namespaced by source (e.g. `linear:issue:ACME-7`).
  -- Resolution matches on this first, so two signals about one issue resolve to
  -- one entity rather than growing one per mention.
  external_id    text NOT NULL,
  name           text NOT NULL,
  attributes     jsonb NOT NULL DEFAULT '{}'::jsonb,
  extractor_version integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One entity per external id: the deterministic pass is idempotent at the
-- database, so re-extracting the same signals makes no duplicates (BRAIN-3 AC4)
-- rather than relying on a check-then-insert that races a concurrent sync.
CREATE UNIQUE INDEX entities_external ON entities (workspace_id, external_id);
CREATE INDEX entities_by_kind ON entities (workspace_id, kind);

CREATE TABLE entity_aliases (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id    text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Aliases are how a short code or handle in conversation resolves to the thing
-- it names; matched case-insensitively, since "ACME-7" and "acme-7" are one
-- ticket. Unique per entity so re-extraction does not stack duplicates.
CREATE UNIQUE INDEX entity_aliases_unique ON entity_aliases (workspace_id, entity_id, lower(alias));
CREATE INDEX entity_aliases_lookup ON entity_aliases (workspace_id, lower(alias));

CREATE TABLE entity_evidence (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id    text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  -- The signal that justifies the entity. Following it must reach the source
  -- text (BRAIN-3 AC2), which is why evidence is a row and not a confidence
  -- number: a belief with no traceable source is an unfalsifiable assertion.
  signal_id    text NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  -- The character span the LLM pass cites. Null for the deterministic pass,
  -- which reads a whole field the source already defined and cites the signal.
  char_start   integer,
  char_end     integer,
  extractor_version integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- One evidence row per (entity, signal, version): re-extracting at the same
-- version is a no-op, and a version bump adds the new evidence beside the old.
CREATE UNIQUE INDEX entity_evidence_unique
  ON entity_evidence (workspace_id, entity_id, signal_id, extractor_version);
CREATE INDEX entity_evidence_by_entity ON entity_evidence (workspace_id, entity_id);

-- NFR-3: new tenant tables get their policies in the same migration.
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities FORCE ROW LEVEL SECURITY;
CREATE POLICY entities_tenant ON entities
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE entity_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY entity_aliases_tenant ON entity_aliases
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE entity_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY entity_evidence_tenant ON entity_evidence
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
