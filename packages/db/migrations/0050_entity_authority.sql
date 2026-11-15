-- 0050 — operational entity kinds and external authority (BRAIN-11).
--
-- The brain graph gains `service`, `environment`, `deployment` and `resource`,
-- and every entity gains an `authority` with an `external_uri`. An
-- external-authority entity is a reference: an owning system holds its facts,
-- and the extractor may link to it but never create, merge or contradict it.
-- `last_synced_at` is the source's own freshness, which is the only thing that
-- may mark one stale.

ALTER TABLE entities DROP CONSTRAINT entities_kind_check;
ALTER TABLE entities ADD CONSTRAINT entities_kind_check CHECK (kind IN (
  'ticket', 'person', 'repo', 'feature', 'component', 'topic', 'page', 'metric',
  'experiment', 'design', 'decision',
  'service', 'environment', 'deployment', 'resource'
));

ALTER TABLE entities
  ADD COLUMN authority      text NOT NULL DEFAULT 'brain'
                              CHECK (authority IN ('brain', 'external')),
  ADD COLUMN external_uri   text,
  ADD COLUMN last_synced_at timestamptz;

-- An external-authority entity must name where it lives; a brain one must not
-- claim an external address.
ALTER TABLE entities ADD CONSTRAINT entities_authority_uri CHECK (
  (authority = 'external' AND external_uri IS NOT NULL)
  OR (authority = 'brain' AND external_uri IS NULL)
);

-- The operational kinds are always external — a brain-authored `service` is a
-- contradiction in terms, and the one BRAIN-7 would merge every night.
ALTER TABLE entities ADD CONSTRAINT entities_operational_external CHECK (
  kind NOT IN ('service', 'environment', 'deployment', 'resource')
  OR authority = 'external'
);
