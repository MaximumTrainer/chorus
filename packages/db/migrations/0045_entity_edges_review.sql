-- 0045 — entity edges and the brain review queue (BRAIN-3, BRAIN-7).
--
-- The LLM pass proposes edges between entities and, where a candidate matches
-- an existing entity but not confidently enough to merge automatically, a
-- review item rather than a silent merge (BRAIN-3 AC3). `brain_review_items` is
-- that queue: BRAIN-3 writes `merge` items below the threshold, BRAIN-7 adds
-- `split`, `stale` and `contradiction`, and NAV-3's inbox reads all of them.
-- Proposing rather than applying is the whole point — an automatic merge that
-- is wrong is very hard to notice and very annoying to undo.

CREATE TABLE entity_edges (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id   text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN (
                   'implements', 'mentions', 'depends_on', 'owned_by', 'measured_by',
                   'decided_in', 'duplicates', 'blocks', 'relates_to'
                 )),
  confidence     real NOT NULL DEFAULT 1.0,
  -- The signal that justifies the edge, like an entity's evidence: an edge with
  -- no traceable source is as unfalsifiable as an entity with none.
  evidence_signal_id text REFERENCES signals(id) ON DELETE SET NULL,
  char_start     integer,
  char_end       integer,
  extractor_version integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- One edge of a kind between an ordered pair: re-extraction updates its
-- confidence rather than stacking duplicates (BRAIN-3 AC4 for edges).
CREATE UNIQUE INDEX entity_edges_unique
  ON entity_edges (workspace_id, from_entity_id, to_entity_id, kind);
CREATE INDEX entity_edges_from ON entity_edges (workspace_id, from_entity_id);
CREATE INDEX entity_edges_to ON entity_edges (workspace_id, to_entity_id);

CREATE TABLE brain_review_items (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('merge', 'split', 'stale', 'contradiction')),
  status       text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'accepted', 'rejected')),
  -- The proposal in full — the entities to merge and the evidence for the
  -- match, both claims of a contradiction, the clusters of a split. Evidence,
  -- not a summary: a merge shown without both sides cannot be decided honestly
  -- and the inbox becomes an accept-everything button (NAV-3 AC2).
  subject      jsonb NOT NULL DEFAULT '{}'::jsonb,
  decided_by   text REFERENCES users(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX brain_review_items_open
  ON brain_review_items (workspace_id, kind, created_at DESC)
  WHERE status = 'open';

ALTER TABLE entity_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_edges FORCE ROW LEVEL SECURITY;
CREATE POLICY entity_edges_tenant ON entity_edges
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE brain_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_review_items FORCE ROW LEVEL SECURITY;
CREATE POLICY brain_review_items_tenant ON brain_review_items
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
